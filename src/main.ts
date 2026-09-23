import { App, Editor, MarkdownView, Menu, Modal, normalizePath, Notice, Plugin, setIcon, Setting, TAbstractFile, TFile, TFolder } from "obsidian";
import { VaultChunkCache } from "./audio/chunk-cache";
import { AudioRecorder, isRecordingSilent, LEVEL_BAND_COUNT, RecordingResult } from "./audio/recorder";
import { ErrorLogModal } from "./error-log-modal";
import { ErrorTracker } from "./error-tracker";
import { t } from "./i18n";
import {
	AudioSource,
	formatTimestampForFilename,
	isSupportedMediaFile,
	isVideoFile,
	logDebug,
	needsTranscription,
	RequestAbortedError,
	resolveNonCollidingPathWithExtension,
	resolvePhysicalPath,
	runSummarizeTextPipeline,
	runTranscribeAndSummarizePipeline,
} from "./pipeline";
import {
	AiTranscribeSummarySettingTab,
	AiTranscribeSummarySettings,
	DEFAULT_CLEANUP_PROMPT,
	DEFAULT_SETTINGS,
	DEFAULT_SUMMARY_PROMPT,
	ENGLISH_DEFAULT_CLEANUP_PROMPT,
	ENGLISH_DEFAULT_SUMMARY_PROMPT,
	RUSSIAN_DEFAULT_CLEANUP_PROMPT,
	RUSSIAN_DEFAULT_SUMMARY_PROMPT,
} from "./settings";
import { normalizeSummaryPrompts, resolveSummaryPrompt } from "./summary-prompts";
import { TaskCenterView, TASK_CENTER_VIEW_TYPE } from "./task-center-view";
import { TaskTracker } from "./task-tracker";
import type { ProgressUpdate } from "./progress";

/** audio/webm -> webm, audio/ogg;codecs=opus -> ogg, etc. */
function extensionForMimeType(mimeType: string): string {
	const subtype = mimeType.split(";")[0].split("/")[1];
	return subtype || "webm";
}

/** Single-character spinner frames - fixed width, so the status bar item doesn't resize/jitter as it animates (unlike a growing "..." suffix). */
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const EXTENSION_MIME_TYPES: Record<string, string> = {
	webm: "audio/webm",
	ogg: "audio/ogg",
	mp3: "audio/mpeg",
	wav: "audio/wav",
	m4a: "audio/mp4",
	mp4: "video/mp4",
	mov: "video/quicktime",
	m4v: "video/x-m4v",
	mkv: "video/x-matroska",
	avi: "video/x-msvideo",
	mpg: "video/mpeg",
	mpeg: "video/mpeg",
};

function mimeTypeForExtension(extension: string): string {
	return EXTENSION_MIME_TYPES[extension.toLowerCase()] ?? "application/octet-stream";
}

/**
 * Above this duration, splitting an oversized recording (chunker.ts's
 * chunkAtSilence) decodes to a large enough in-memory PCM buffer that it
 * risks exhausting tab memory on constrained machines - warn before it
 * happens rather than let the decode fail unpredictably. Based on duration
 * alone (not file size, which varies with the configured bitrate) since
 * that's what drives decoded PCM size; assumes a worst-case stereo/48kHz
 * source (~2GB at 3hrs) since MediaRecorder doesn't expose the actual
 * sample rate/channel count picked by the browser/OS.
 */
const LONG_RECORDING_WARNING_MS = 3 * 60 * 60 * 1000;

/**
 * Below this duration a recording is too short to contain any real speech -
 * the encoded blob is essentially just container/header bytes. Sending that
 * to the transcription provider fails with an opaque HTTP 400 ("Provider
 * returned 400") rather than a message that explains what happened, so this
 * is checked up front and short-circuits with a clear Notice instead.
 */
const MIN_RECORDING_MS = 1000;

function formatElapsed(ms: number): string {
	const totalSeconds = Math.floor(ms / 1000);
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	const pad = (n: number) => n.toString().padStart(2, "0");
	return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

type RecordingState = "idle" | "recording" | "paused";

/** Shape of app.plugins.plugins['notebook-navigator']?.api, limited to the file-menu registration this plugin uses. See https://github.com/johansan/notebook-navigator/blob/main/docs/api-reference.md#menus-api */
interface NotebookNavigatorApi {
	menus?: {
		registerFileMenu?: (
			callback: (context: { addItem: Menu["addItem"]; file: TFile; selection: { mode: "single" | "multiple" } }) => void
		) => () => void;
	};
}

class StopRecordingConfirmModal extends Modal {
	private confirmed = false;

	constructor(app: App, private onConfirm: () => void, private onCancel: () => void) {
		super(app);
	}

	onOpen() {
		this.setTitle(t("Stop recording?"));
		this.contentEl.createEl("p", { text: t("This will end the current recording. This can't be undone.") });

		new Setting(this.contentEl)
			.addButton((button) => button.setButtonText(t("Cancel")).onClick(() => this.close()))
			.addButton((button) =>
				button
					.setButtonText(t("Stop recording"))
					.setDestructive()
					.setCta()
					.onClick(() => {
						this.confirmed = true;
						this.close();
						this.onConfirm();
					})
			);
	}

	onClose() {
		this.contentEl.empty();
		if (!this.confirmed) this.onCancel();
	}
}

/**
 * Confirms before starting a recording when triggered from the ribbon icon -
 * dragging the ribbon icon to reorder it (Obsidian lets users drag ribbon
 * icons in the sidebar) can register as a click on mouseup and silently
 * start recording. The command palette/hotkey path skips this since it
 * can't be triggered by a drag.
 */
class StartRecordingConfirmModal extends Modal {
	private confirmed = false;

	constructor(app: App, private onConfirm: () => void, private onCancel: () => void) {
		super(app);
	}

	onOpen() {
		this.setTitle(t("Start recording?"));
		this.contentEl.createEl("p", { text: t("This will start recording audio from your microphone.") });

		new Setting(this.contentEl)
			.addButton((button) => button.setButtonText(t("Cancel")).onClick(() => this.close()))
			.addButton((button) =>
				button
					.setButtonText(t("Start recording"))
					.setCta()
					.onClick(() => {
						this.confirmed = true;
						this.close();
						this.onConfirm();
					})
			);
	}

	onClose() {
		this.contentEl.empty();
		if (!this.confirmed) this.onCancel();
	}
}

/** Shown after stop() when the recorded clip's overall RMS is at/below the silence threshold - lets the user transcribe anyway (e.g. a quiet but valid recording) instead of silently discarding it. */
class SilentRecordingConfirmModal extends Modal {
	private confirmed = false;

	constructor(app: App, private undecodable: boolean, private onConfirm: () => void, private onCancel: () => void) {
		super(app);
	}

	onOpen() {
		if (this.undecodable) {
			this.setTitle(t("Recording could not be checked"));
			this.contentEl.createEl("p", {
				text: t("This audio could not be read - it may be empty or corrupted. Sending it for transcription is likely to fail."),
			});
		} else {
			this.setTitle(t("Recording appears to be silent"));
			this.contentEl.createEl("p", {
				text: t("No audio signal was detected in this recording. You can still transcribe and summarize it, but the result may be empty."),
			});
		}

		new Setting(this.contentEl)
			.addButton((button) => button.setButtonText(t("Discard")).onClick(() => this.close()))
			.addButton((button) =>
				button
					.setButtonText(t("Transcribe anyway"))
					.setCta()
					.onClick(() => {
						this.confirmed = true;
						this.close();
						this.onConfirm();
					})
			);
	}

	onClose() {
		this.contentEl.empty();
		if (!this.confirmed) this.onCancel();
	}
}

export default class AiTranscribeSummaryPlugin extends Plugin {
	declare settings: AiTranscribeSummarySettings;

	private statusBarItem!: HTMLElement;
	private statusBarDotEl!: HTMLElement;
	private statusBarTextEl!: HTMLElement;
	private state: RecordingState = "idle";
	/** True while start/stop is in flight (awaiting mic permission or recorder.stop()'s final chunk) - blocks re-entrant start/stop so a quick second action can't race the recorder's stream/chunks out from under the in-flight one. */
	private transitioning = false;
	/** Set once onunload() runs, so a startRecording() whose getUserMedia() was still pending at unload time can detect teardown and discard the now-unmanaged stream instead of continuing as if the plugin were still active. */
	private unloaded = false;
	private segmentStartedAt = 0;
	private accumulatedMs = 0;
	private timerIntervalId: number | undefined;
	private ribbonIconEl!: HTMLElement;
	private recorder = new AudioRecorder();
	/** Guards the dead-mic Notice so it's shown at most once per recording, even though onDeadMic itself already fires only once. */
	private deadMicWarned = false;

	/**
	 * Last markdown note the user was actually editing, updated live via
	 * "active-leaf-change". Reading `workspace.activeEditor`/`getActiveViewOfType`
	 * at click time doesn't work for the right-click "Transcribe & summarize" menu
	 * item: opening the context menu itself moves the active leaf to the file
	 * explorer before our click handler runs, so live lookups return null even
	 * though a note is still open on screen. This cache survives that.
	 */
	private lastMarkdownView: MarkdownView | undefined;

	/** Unregisters this plugin's Notebook Navigator file-menu callback, if that integration was set up in onload(). */
	private notebookNavigatorMenuDispose: (() => void) | undefined;

	/** One entry per in-flight pipeline job (a right-click "Transcribe & summarize", or the post-recording pipeline), keyed by a locally-unique id - so one job finishing doesn't stop/hide the shared status bar spinner while others are still running. */
	private activePipelineJobs = new Map<number, string>();
	/** AbortController per in-flight pipeline job, keyed the same as activePipelineJobs - "Stop transcription/summary" aborts every job currently running, since the status bar/command palette don't distinguish which job is which. */
	private pipelineJobControllers = new Map<number, AbortController>();
	private nextPipelineJobId = 0;
	private pipelineAnimationIntervalId: number | undefined;
	private pipelineAnimationFrame = 0;
	private taskTracker = new TaskTracker();
	private chunkCache = new VaultChunkCache(this.app);
	private errorTracker = new ErrorTracker(this.app);

	async onload() {
		await this.loadSettings();
		await this.errorTracker.load();
		this.registerView(TASK_CENTER_VIEW_TYPE, (leaf) =>
			new TaskCenterView(leaf, this.taskTracker, {
				cancelTask: (id) => this.stopPipelineJob(id),
				stopRecording: () => this.requestStopRecording(),
				openErrorLog: () => this.openErrorLog(),
				retryTask: (id) => {
					const task = this.taskTracker.getTasks().find((t) => t.id === id);
					task?.retryAction?.();
				},
				dismissTask: (id) => this.taskTracker.dismiss(id),
			})
		);

		this.statusBarItem = this.addStatusBarItem();
		this.statusBarDotEl = this.statusBarItem.createSpan({ cls: "ai-transcribe-summary-status-dot" });
		this.statusBarDotEl.hide();
		this.statusBarTextEl = this.statusBarItem.createSpan();
		this.statusBarItem.addEventListener("click", () => void this.openTaskCenter());
		this.statusBarItem.addClass("ai-transcribe-summary-status");
		this.statusBarItem.setAttribute("aria-label", t("Open AI tasks"));
		this.statusBarItem.hide();

		this.addRibbonIcon("list-checks", t("Open AI tasks"), () => void this.openTaskCenter());

		this.addCommand({
			id: "open-task-center",
			name: t("Open task center"),
			callback: () => void this.openTaskCenter(),
		});

		this.addCommand({
			id: "open-error-log",
			name: t("Open error log"),
			callback: () => this.openErrorLog(),
		});

		this.addCommand({
			id: "copy-last-error",
			name: t("Copy last error to clipboard"),
			callback: async () => {
				const latest = this.errorTracker.getLatestError();
				if (!latest) {
					new Notice(t("No errors recorded"));
					return;
				}
				const text = `[${new Date(latest.timestamp).toLocaleString()}] ${latest.action}\n${latest.message}${latest.details ? `\n\n${latest.details}` : ""}`;
				await navigator.clipboard.writeText(text);
				new Notice(t("Error copied to clipboard"));
			},
		});

		this.ribbonIconEl = this.addRibbonIcon("mic", t("Start meeting recording"), () => {
			if (this.transitioning) return;
			if (this.state === "idle") {
				this.requestStartRecording(true);
			} else {
				this.requestStopRecording(true);
			}
		});
		this.ribbonIconEl.addClass("ai-transcribe-summary-ribbon-icon");

		this.addCommand({
			id: "toggle-recording",
			name: t("Start/Stop recording"),
			checkCallback: (checking) => {
				if (this.transitioning) return false;
				if (!checking) {
					if (this.state === "idle") {
						this.requestStartRecording();
					} else {
						this.requestStopRecording();
					}
				}
				return true;
			},
		});

		this.addCommand({
			id: "toggle-pause-recording",
			name: t("Pause/resume recording"),
			checkCallback: (checking) => {
				if (this.state === "idle" || this.transitioning) return false;
				if (!checking) this.togglePause();
				return true;
			},
		});

		this.addCommand({
			id: "transcribe-and-summarize-active-file",
			name: t("Transcribe & summarize active file"),
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || !isSupportedMediaFile(file)) return false;
				if (!checking) void this.transcribeAndSummarizeFile(file);
				return true;
			},
		});

		this.addCommand({
			id: "stop-transcription-summary",
			name: t("Stop transcription/summary"),
			checkCallback: (checking) => {
				if (this.pipelineJobControllers.size === 0) return false;
				if (!checking) this.stopPipelineJobs();
				return true;
			},
		});

		this.addCommand({
			id: "summarize-active-note",
			name: t("Summarize note"),
			editorCallback: (editor, view) => void this.summarizeText(editor, editor.getValue(), false, view.file?.basename ?? "note"),
		});

		this.addSettingTab(new AiTranscribeSummarySettingTab(this.app, this));

		this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => this.onFileMenu(menu, file)));
		this.app.workspace.onLayoutReady(() => this.registerNotebookNavigatorMenu());

		this.lastMarkdownView = this.app.workspace.getActiveViewOfType(MarkdownView) ?? undefined;
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", (leaf) => {
				if (leaf?.view instanceof MarkdownView) {
					this.lastMarkdownView = leaf.view;
				}
			})
		);
	}

	private onFileMenu(menu: Menu, file: TAbstractFile) {
		if (!(file instanceof TFile)) return;
		this.addFileMenuItems(menu, file);
	}

	private addFileMenuItems(menu: Pick<Menu, "addItem">, file: TFile) {
		if (isSupportedMediaFile(file)) {
			if (this.settings.generateSummary) {
				for (const prompt of this.settings.summaryPrompts) {
					menu.addItem((item) =>
						item
							.setTitle(t("Transcribe & summarize — {prompt}", { prompt: prompt.name }))
							.setIcon("captions")
							.onClick(() => void this.transcribeAndSummarizeFile(file, prompt.id))
					);
				}
			} else {
				menu.addItem((item) =>
					item
						.setTitle(t("Transcribe"))
						.setIcon("captions")
						.onClick(() => void this.transcribeAndSummarizeFile(file))
				);
			}
			return;
		}

		if (file.extension === "md") {
			menu.addItem((item) =>
				item
					.setTitle(t("Summarize note"))
					.setIcon("captions")
					.onClick(() => void this.summarizeNoteFile(file))
			);
		}
	}

	/**
	 * Notebook Navigator replaces the default file explorer with its own UI and builds its
	 * own Menu instance on right-click instead of firing the standard "file-menu" workspace
	 * event, so onFileMenu() above never runs there. Notebook Navigator instead exposes its
	 * own extension API (api.menus.registerFileMenu) for this exact case - hook into it when
	 * present so our items also show up inside its navigator. No-op if it isn't installed.
	 * Called from onLayoutReady() rather than directly in onload(), since Obsidian doesn't
	 * guarantee plugin load order - Notebook Navigator's api may not exist yet otherwise.
	 */
	private registerNotebookNavigatorMenu() {
		const nn = (this.app as unknown as { plugins?: { plugins?: Record<string, { api?: NotebookNavigatorApi }> } }).plugins?.plugins?.[
			"notebook-navigator"
		]?.api;

		try {
			this.notebookNavigatorMenuDispose = nn?.menus?.registerFileMenu?.(({ addItem, file, selection }) => {
				if (selection.mode !== "single") return;
				this.addFileMenuItems({ addItem }, file);
			});
		} catch (error) {
			logDebug("Notebook Navigator menu integration failed to register", error);
		}
	}

	/** Right-click "Summarize note" - unlike the editor-command path, the file clicked from the file explorer isn't necessarily the active editor, so this opens/activates it first to get an Editor to write the summary into. */
	private async summarizeNoteFile(file: TFile): Promise<void> {
		const leaf = this.app.workspace.getLeaf(false);
		await leaf.openFile(file);
		const view = leaf.view;
		if (!(view instanceof MarkdownView)) {
			new Notice(t('Could not open "{name}" for editing.', { name: file.basename }));
			return;
		}
		await this.summarizeText(view.editor, view.editor.getValue(), false, file.basename);
	}

	private async summarizeText(editor: Editor, text: string, replaceSelection: boolean, fileLabel: string): Promise<void> {
		const { jobId, signal } = this.beginPipelineJob(t("Summarize “{name}”", { name: fileLabel }));
		const taskId = `pipeline-${jobId}`;
		let succeeded = false;
		try {
			await runSummarizeTextPipeline(this.settings, { text, editor, replaceSelection, fileLabel }, { onProgress: (status) => this.showPipelineProgress(jobId, status), signal });
			succeeded = true;
		} catch (error) {
			this.reportPipelineError("summarize", error, fileLabel, undefined, taskId);
		} finally {
			this.endPipelineJob(jobId, succeeded);
		}
	}

	private async transcribeAndSummarizeFile(file: TFile, summaryPromptId?: string): Promise<void> {
		const summaryPrompt = summaryPromptId
			? resolveSummaryPrompt(this.settings.summaryPrompts, summaryPromptId).prompt
			: resolveSummaryPrompt(this.settings.summaryPrompts, this.settings.defaultSummaryPromptId).prompt;
		const transitionTaskId = `file-${Date.now()}`;
		this.taskTracker.start({
			id: transitionTaskId,
			kind: "pipeline",
			title: t("Process “{name}”", { name: file.basename }),
			status: t("Checking audio"),
			startedAt: Date.now(),
			canCancel: false,
		});

		let blob: Blob;
		const isVideo = isVideoFile(file);
		const physicalPath = resolvePhysicalPath(this.app, file);
		try {
			// Video files on disk don't need to be buffered entirely into memory up front -
			// FFmpeg streams them directly from the path. If FFmpeg isn't present, the fallback
			// reads the file on demand.
			if (isVideo && physicalPath) {
				blob = new Blob([], { type: mimeTypeForExtension(file.extension) });
			} else {
				blob = new Blob([await this.app.vault.readBinary(file)], { type: mimeTypeForExtension(file.extension) });
			}
		} catch (error) {
			this.reportPipelineError(
				"transcribe & summarize",
				error,
				file.basename,
				() => void this.transcribeAndSummarizeFile(file, summaryPromptId),
				transitionTaskId
			);
			return;
		}
		await this.runPipelineWithSilenceCheck(
			{
				blob,
				mimeType: blob.type,
				baseName: file.basename,
				audioFile: file,
				extractAudio: isVideo,
				filePath: physicalPath,
			},
			transitionTaskId,
			summaryPrompt
		);
	}

	/** Logs and surfaces a pipeline failure - a user-initiated stop gets a neutral Notice instead of the usual red "failed" one. */
	private reportPipelineError(action: string, error: unknown, sourceName?: string, retryAction?: () => void, taskId?: string) {
		if (error instanceof RequestAbortedError) {
			logDebug(`${action} stopped by user`, error);
			new Notice(error.message);
			if (taskId) this.taskTracker.finish(taskId);
			return;
		}
		console.error(`ai-transcribe-summary: ${action} failed`, error);
		const errorRecord = this.errorTracker.recordError(action, error, sourceName);
		if (taskId) {
			this.taskTracker.fail(taskId, errorRecord.message, errorRecord.details, retryAction);
		}
		const localizedAction = t(action);
		const actionLabel = localizedAction === action ? `${action[0].toUpperCase()}${action.slice(1)}` : localizedAction;
		new Notice(t("{action} failed: {message}. See AI tasks for details.", { action: actionLabel, message: errorRecord.message }), 10000);
	}

	/** Registers a new pipeline job with its own AbortController and returns its id/signal, to be passed to showPipelineProgress/endPipelineJob for the lifetime of that job. */
	private beginPipelineJob(title: string): { jobId: number; signal: AbortSignal } {
		const jobId = this.nextPipelineJobId++;
		const controller = new AbortController();
		this.pipelineJobControllers.set(jobId, controller);
		this.taskTracker.start({
			id: `pipeline-${jobId}`,
			kind: "pipeline",
			title,
			status: t("Starting"),
			startedAt: Date.now(),
			canCancel: true,
		});
		return { jobId, signal: controller.signal };
	}

	/** Aborts every currently-running pipeline job - triggered by the "Stop transcription/summary" command since the status bar/command palette don't distinguish which job is which. */
	private stopPipelineJobs() {
		for (const [jobId, controller] of this.pipelineJobControllers) {
			controller.abort();
			this.taskTracker.update(`pipeline-${jobId}`, { status: t("Stopping"), canCancel: false, progress: undefined });
		}
		new Notice(t("Stopping..."));
	}

	private stopPipelineJob(taskId: string) {
		const jobId = Number(taskId.replace(/^pipeline-/, ""));
		const controller = this.pipelineJobControllers.get(jobId);
		if (!controller) return;
		controller.abort();
		this.taskTracker.update(taskId, { status: t("Stopping"), canCancel: false, progress: undefined });
	}

	private showPipelineProgress(jobId: number, update: ProgressUpdate) {
		this.activePipelineJobs.set(jobId, update.status);
		const progress =
			update.completed !== undefined && update.total !== undefined && update.total > 0
				? { completed: Math.max(0, Math.min(update.completed, update.total)), total: update.total, unit: update.unit }
				: undefined;
		const taskId = `pipeline-${jobId}`;
		if (!this.taskTracker.hasTask(taskId)) {
			this.taskTracker.start({
				id: taskId,
				kind: "pipeline",
				title: t("Process audio"),
				status: update.status,
				startedAt: Date.now(),
				canCancel: true,
				progress,
			});
		} else {
			this.taskTracker.update(taskId, { status: update.status, progress });
		}
		this.statusBarItem.show();
		this.statusBarDotEl.hide();
		this.renderPipelineProgress();

		if (this.pipelineAnimationIntervalId === undefined) {
			this.pipelineAnimationIntervalId = window.setInterval(() => this.renderPipelineProgress(), 100);
			this.registerInterval(this.pipelineAnimationIntervalId);
		}
	}

	private renderPipelineProgress() {
		const frame = SPINNER_FRAMES[this.pipelineAnimationFrame];
		this.pipelineAnimationFrame = (this.pipelineAnimationFrame + 1) % SPINNER_FRAMES.length;

		// Map iteration order is insertion order, so this is the most recently *started* job,
		// not necessarily the most recently updated one - a reasonable stand-in given the
		// status bar can only show one line, and job status changes are infrequent.
		const statuses = [...this.activePipelineJobs.values()];
		const mostRecent = statuses[statuses.length - 1];
		const otherCount = statuses.length - 1;
		const suffix = otherCount > 0 ? ` (+${otherCount} more)` : "";
		this.statusBarTextEl.setText(`${frame} ${mostRecent}${suffix}`);
	}

	/** Ends one pipeline job. Only stops the shared spinner/hides the status bar once no other job is still active. */
	private endPipelineJob(jobId: number, succeeded = true) {
		this.activePipelineJobs.delete(jobId);
		this.pipelineJobControllers.delete(jobId);
		if (succeeded) {
			this.taskTracker.finish(`pipeline-${jobId}`);
		}
		if (this.activePipelineJobs.size > 0) {
			this.renderPipelineProgress();
			return;
		}

		if (this.pipelineAnimationIntervalId !== undefined) {
			window.clearInterval(this.pipelineAnimationIntervalId);
			this.pipelineAnimationIntervalId = undefined;
		}
		if (this.state === "idle") {
			this.statusBarItem.hide();
		} else {
			// A recording is still in progress - restore its display immediately instead of
			// leaving the last spinner frame on screen until the next 1s timer tick.
			this.updateStatusBar();
		}
	}

	onunload() {
		this.unloaded = true;
		this.notebookNavigatorMenuDispose?.();
		this.stopTimer();
		if (this.state !== "idle") {
			this.recorder.discard();
		}
	}

	/** Ribbon icon clicks always confirm (forceConfirm) since dragging the ribbon icon to reorder it can register as a click; the command palette/hotkey path only confirms when the user has opted into confirmBeforeStoppingRecording. */
	private requestStopRecording(forceConfirm = false) {
		if (forceConfirm || this.settings.confirmBeforeStoppingRecording) {
			// Reserve the transition immediately so a second stop action can't open another
			// confirm modal while this one is still open - only one stopRecording() may run
			// against the recorder at a time. Released if the user cancels.
			this.transitioning = true;
			new StopRecordingConfirmModal(
				this.app,
				() => void this.stopRecording(),
				() => {
					this.transitioning = false;
				}
			).open();
		} else {
			void this.stopRecording();
		}
	}

	/** Ribbon icon clicks always confirm (forceConfirm) since dragging the ribbon icon to reorder it can register as a click; the command palette/hotkey path only confirms when the user has opted into confirmBeforeStartingRecording. */
	private requestStartRecording(forceConfirm = false) {
		if (forceConfirm || this.settings.confirmBeforeStartingRecording) {
			this.transitioning = true;
			new StartRecordingConfirmModal(
				this.app,
				() => void this.startRecording(),
				() => {
					this.transitioning = false;
				}
			).open();
		} else {
			void this.startRecording();
		}
	}

	private togglePause() {
		if (this.state === "recording") {
			this.pauseRecording();
		} else if (this.state === "paused") {
			this.resumeRecording();
		}
	}

	private async startRecording() {
		this.transitioning = true;
		this.deadMicWarned = false;
		try {
			await this.recorder.start({
				microphoneDeviceId: this.settings.microphoneDeviceId,
				bitrateKbps: this.settings.audioBitrateKbps,
				silenceAutoStopMinutes: this.settings.silenceAutoStopMinutes,
				onSilenceTimeout: () => this.autoStopRecording(t("{minutes} minutes of silence", { minutes: this.settings.silenceAutoStopMinutes })),
				onLevel: (bands) => this.updateRibbonLevel(bands),
				onDeadMic: () => this.warnDeadMic(),
			});
		} catch (error) {
			console.error("ai-transcribe-summary: failed to start recording", error);
			new Notice(t("Could not start recording - check microphone permissions."));
			return;
		} finally {
			this.transitioning = false;
		}

		if (this.unloaded) {
			// Plugin was disabled/reloaded while getUserMedia() was still pending - the mic
			// stream this just acquired is unmanaged by anything still running, so tear it
			// down immediately instead of continuing to "record" past teardown.
			this.recorder.discard();
			return;
		}

		this.state = "recording";
		this.accumulatedMs = 0;
		this.segmentStartedAt = Date.now();
		this.taskTracker.start({
			id: "recording",
			kind: "recording",
			title: t("Meeting recording"),
			status: t("Recording"),
			startedAt: this.segmentStartedAt,
			canCancel: true,
		});

		setIcon(this.ribbonIconEl, "audio-lines");
		this.ribbonIconEl.addClass("is-active");
		this.ribbonIconEl.setAttribute("aria-label", t("Stop meeting recording"));

		this.statusBarItem.show();
		this.updateStatusBar();
		this.startTimer();
	}

	/**
	 * Writes real per-band levels (already ballistics-processed in AudioRecorder - fast attack,
	 * slow release, per-band peak auto-gain) straight to the ribbon's --ai-transcribe-summary-bar-N
	 * CSS vars for the "audio-lines" icon. No-op once not recording, so a frame queued just
	 * before pause/stop can't resurrect the animation.
	 */
	private updateRibbonLevel(bands: Float32Array) {
		if (this.state !== "recording") return;
		for (let i = 0; i < bands.length; i++) {
			this.ribbonIconEl.style.setProperty(`--ai-transcribe-summary-bar-${i + 1}`, bands[i].toFixed(3));
		}
	}

	private resetRibbonLevel() {
		for (let i = 1; i <= LEVEL_BAND_COUNT; i++) {
			this.ribbonIconEl.style.removeProperty(`--ai-transcribe-summary-bar-${i}`);
		}
	}

	/** Surfaces a likely-dead mic (no input at all in the first few seconds) immediately, rather than letting the user talk into a recording that's silently producing nothing. */
	private warnDeadMic() {
		if (this.deadMicWarned || this.state !== "recording") return;
		this.deadMicWarned = true;
		new Notice(t("No microphone input detected. Check your mic - this recording may come out empty."), 8000);
	}

	private pauseRecording() {
		this.recorder.pause();
		this.accumulatedMs += Date.now() - this.segmentStartedAt;
		this.state = "paused";
		this.taskTracker.update("recording", { status: t("Paused") });
		this.ribbonIconEl.addClass("is-paused");
		this.resetRibbonLevel();
		this.stopTimer();
		this.updateStatusBar();
	}

	private resumeRecording() {
		this.recorder.resume();
		this.segmentStartedAt = Date.now();
		this.state = "recording";
		this.taskTracker.update("recording", { status: t("Recording") });
		this.ribbonIconEl.removeClass("is-paused");
		this.updateStatusBar();
		this.startTimer();
	}

	private async stopRecording() {
		this.transitioning = true;
		this.stopTimer();
		this.taskTracker.update("recording", { status: t("Finishing recording"), canCancel: false });

		let result: RecordingResult;
		try {
			result = await this.recorder.stop();
		} catch (error) {
			console.error("ai-transcribe-summary: failed to stop recording", error);
			new Notice(t("Recording stop failed - no audio was saved."));
			this.state = "idle";
			this.transitioning = false;
			setIcon(this.ribbonIconEl, "mic");
			this.ribbonIconEl.removeClass("is-active");
			this.ribbonIconEl.removeClass("is-paused");
			this.ribbonIconEl.setAttribute("aria-label", t("Start meeting recording"));
			this.resetRibbonLevel();
			this.statusBarItem.hide();
			this.taskTracker.finish("recording");
			return;
		}

		this.state = "idle";
		this.transitioning = false;
		setIcon(this.ribbonIconEl, "mic");
		this.ribbonIconEl.removeClass("is-active");
		this.ribbonIconEl.removeClass("is-paused");
		this.ribbonIconEl.setAttribute("aria-label", t("Start meeting recording"));
		this.resetRibbonLevel();

		if (result.durationMs < MIN_RECORDING_MS) {
			this.taskTracker.finish("recording");
			new Notice(t("Recording was too short to transcribe - nothing was saved."));
			return;
		}

		// Raw audio is always preserved regardless of what transcription/summary do downstream.
		let savedFile: TFile | undefined;
		if (this.settings.saveAudioFile) {
			this.taskTracker.update("recording", { status: t("Saving audio") });
			savedFile = await this.saveRecording(result);
		}

		if (result.durationMs > LONG_RECORDING_WARNING_MS) {
			new Notice(
				`${t("This recording is over {hours} hours long. If it needs to be split for transcription, decoding it may use a lot of memory and could fail on this device.", {
					hours: Math.round(LONG_RECORDING_WARNING_MS / (60 * 60 * 1000)),
				})}${savedFile ? t(" The audio file is already saved, so it's safe either way.") : ""}`,
				10000
			);
		}

		const shouldTranscribe = needsTranscription(this.settings);
		if (shouldTranscribe) {
			this.taskTracker.update("recording", { status: t("Checking audio") });
		} else {
			this.taskTracker.finish("recording");
		}

		await this.runPipelineWithSilenceCheck(
			{
				blob: result.blob,
				mimeType: result.mimeType,
				baseName: savedFile?.basename ?? `meeting ${formatTimestampForFilename(new Date())}`,
				audioFile: savedFile,
			},
			shouldTranscribe ? "recording" : undefined
		);
	}

	/**
	 * Checks `source.blob` for silence before handing it to the pipeline - shared by the
	 * live-recording flow (stopRecording) and the existing-file flow (transcribeAndSummarizeFile,
	 * reached via the command palette or either right-click file menu), since both can end up
	 * with a silent clip: a recording captured with no signal, or a pre-existing audio file
	 * that's blank/corrupted.
	 */
	private async runPipelineWithSilenceCheck(source: AudioSource, transitionTaskId?: string, summaryPrompt?: string) {
		// The check exists to protect the transcription API call from being wasted on a silent/dead
		// clip - when nothing downstream (transcript, cleanup, summary) needs transcription at all,
		// there's no such call to protect, so skip straight through.
		if (!needsTranscription(this.settings)) {
			if (transitionTaskId) this.taskTracker.finish(transitionTaskId);
			await this.runPipeline(source, undefined, summaryPrompt);
			return;
		}

		// Video is always decoded by the transcription provider and emitted as WAV chunks.
		// Decoding it here too just to check silence would do the most memory-intensive work twice.
		if (source.extractAudio) {
			await this.runPipeline(source, transitionTaskId, summaryPrompt);
			return;
		}

		// An undecodable blob (near-empty/corrupt audio, or a genuinely unsupported format) is
		// surfaced to the user the same way a silent recording is, rather than proceeding straight
		// to the transcription provider - which would otherwise fail with an opaque HTTP 400.
		let silent = false;
		let undecodable = false;
		try {
			silent = await isRecordingSilent(source.blob);
		} catch (error) {
			console.error("ai-transcribe-summary: silence check failed", error);
			undecodable = true;
		}

		if (silent || undecodable) {
			new SilentRecordingConfirmModal(
				this.app,
				undecodable,
				() => void this.runPipeline(source, transitionTaskId, summaryPrompt),
				() => {
					if (transitionTaskId) this.taskTracker.finish(transitionTaskId);
					/* discarded - raw audio (if saveAudioFile is on, or the file already in the vault) is untouched */
				}
			).open();
			return;
		}

		await this.runPipeline(source, transitionTaskId, summaryPrompt);
	}

	private async runPipeline(source: AudioSource, transitionTaskId?: string, summaryPrompt?: string) {
		const { jobId, signal } = this.beginPipelineJob(t("Process “{name}”", { name: source.baseName }));
		const taskId = `pipeline-${jobId}`;
		if (transitionTaskId) this.taskTracker.finish(transitionTaskId);
		let succeeded = false;
		try {
			await runTranscribeAndSummarizePipeline(this.app, this.settings, source, {
				targetView: this.lastMarkdownView,
				summaryPrompt,
				onProgress: (status) => this.showPipelineProgress(jobId, status),
				signal,
				chunkCache: this.chunkCache,
			});
			succeeded = true;
		} catch (error) {
			this.reportPipelineError("transcribe & summarize", error, source.baseName, () => void this.runPipeline(source, undefined, summaryPrompt), taskId);
		} finally {
			this.endPipelineJob(jobId, succeeded);
		}
	}

	openErrorLog(): void {
		new ErrorLogModal(this.app, this.errorTracker).open();
	}

	private async saveRecording(result: RecordingResult): Promise<TFile | undefined> {
		const folderPath = normalizePath(this.settings.audioFolder);

		try {
			const existingFolder = this.app.vault.getAbstractFileByPath(folderPath);
			if (!existingFolder) {
				await this.app.vault.createFolder(folderPath);
			} else if (!(existingFolder instanceof TFolder)) {
				new Notice(t('Audio folder "{path}" is not a folder - recording not saved.', { path: folderPath }));
				return undefined;
			}
		} catch (error) {
			console.error("ai-transcribe-summary: failed to create audio folder", error);
			new Notice(t("Failed to create audio folder - recording not saved. See console for details."));
			return undefined;
		}

		const extension = extensionForMimeType(result.mimeType);
		const now = new Date();
		const fileName = formatTimestampForFilename(now);
		const filePath = resolveNonCollidingPathWithExtension(this.app, folderPath, fileName, extension);

		try {
			const arrayBuffer = await result.blob.arrayBuffer();
			const file = await this.app.vault.createBinary(filePath, arrayBuffer);
			new Notice(t("Recording saved to {path}", { path: filePath }));
			return file;
		} catch (error) {
			console.error("ai-transcribe-summary: failed to save recording", error);
			new Notice(t("Failed to save recording audio file - see console for details."));
			return undefined;
		}
	}

	private startTimer() {
		this.timerIntervalId = window.setInterval(() => this.updateStatusBar(), 1000);
		this.registerInterval(this.timerIntervalId);
	}

	private stopTimer() {
		if (this.timerIntervalId !== undefined) {
			window.clearInterval(this.timerIntervalId);
			this.timerIntervalId = undefined;
		}
	}

	private updateStatusBar() {
		const elapsed = this.accumulatedMs + (this.state === "recording" ? Date.now() - this.segmentStartedAt : 0);

		// While a pipeline job is showing its spinner, let it own the status bar text - otherwise
		// this 1s timer tick and the 100ms spinner tick fight over the same line. The max-duration
		// check below still runs regardless, so a long recording auto-stops even mid-pipeline-job.
		if (this.activePipelineJobs.size === 0) {
			const isPaused = this.state === "paused";
			const label = t(isPaused ? "Paused" : "Recording");
			this.statusBarDotEl.show();
			this.statusBarDotEl.toggleClass("is-paused", isPaused);
			this.statusBarTextEl.setText(`${label} ${formatElapsed(elapsed)}`);
		}

		const maxMs = this.settings.maxRecordingHours * 60 * 60 * 1000;
		if (this.state === "recording" && maxMs > 0 && elapsed >= maxMs) {
			this.autoStopRecording(t("the {hours}-hour maximum recording duration", { hours: this.settings.maxRecordingHours }));
		}
	}

	/** Stops the recording without the usual confirm-before-stopping prompt, since the user isn't the one initiating it. */
	private autoStopRecording(reason: string) {
		if (this.state === "idle" || this.transitioning) return;
		new Notice(t("Recording auto-stopped: reached {reason}.", { reason }));
		void this.stopRecording();
	}

	private async openTaskCenter(): Promise<void> {
		let leaf = this.app.workspace.getLeavesOfType(TASK_CENTER_VIEW_TYPE)[0];
		if (!leaf) {
			leaf = this.app.workspace.getRightLeaf(false) ?? this.app.workspace.getLeaf(true);
			await leaf.setViewState({ type: TASK_CENTER_VIEW_TYPE, active: true });
		}
		await this.app.workspace.revealLeaf(leaf);
		if (leaf.view instanceof TaskCenterView) {
			leaf.view.refresh();
		}
	}

	async loadSettings() {
		const saved = ((await this.loadData()) ?? {}) as Partial<AiTranscribeSummarySettings> & { summaryPrompt?: string };
		const { summaryPrompt: legacySummaryPrompt, ...savedSettings } = saved;
		const summaryPrompts = normalizeSummaryPrompts(
			saved.summaryPrompts,
			legacySummaryPrompt,
			DEFAULT_SUMMARY_PROMPT,
			t("Default"),
			[ENGLISH_DEFAULT_SUMMARY_PROMPT, RUSSIAN_DEFAULT_SUMMARY_PROMPT]
		);
		const defaultSummaryPromptId = summaryPrompts.some((prompt) => prompt.id === saved.defaultSummaryPromptId)
			? saved.defaultSummaryPromptId!
			: summaryPrompts[0].id;
		const cleanupPrompt =
			!saved.cleanupPrompt || saved.cleanupPrompt === ENGLISH_DEFAULT_CLEANUP_PROMPT || saved.cleanupPrompt === RUSSIAN_DEFAULT_CLEANUP_PROMPT
				? DEFAULT_CLEANUP_PROMPT
				: saved.cleanupPrompt;

		// Object.assign only merges top-level keys - a saved settings file from
		// before a field was added to a nested per-provider object (e.g.
		// temperature) would otherwise replace that whole object wholesale and
		// leave the new field undefined, instead of falling back to its default.
		this.settings = {
			...DEFAULT_SETTINGS,
			...savedSettings,
			summaryPrompts,
			defaultSummaryPromptId,
			cleanupPrompt,
			providers: {
				openai: { ...DEFAULT_SETTINGS.providers.openai, ...saved.providers?.openai },
				openrouter: { ...DEFAULT_SETTINGS.providers.openrouter, ...saved.providers?.openrouter },
			},
			summaryProviders: {
				openai: { ...DEFAULT_SETTINGS.summaryProviders.openai, ...saved.summaryProviders?.openai },
				openrouter: { ...DEFAULT_SETTINGS.summaryProviders.openrouter, ...saved.summaryProviders?.openrouter },
				gemini: { ...DEFAULT_SETTINGS.summaryProviders.gemini, ...saved.summaryProviders?.gemini },
			},
		};
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
