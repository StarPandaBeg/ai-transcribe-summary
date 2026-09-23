import { App, Editor, MarkdownView, normalizePath, Notice, TFile, TFolder } from "obsidian";
import { t } from "./i18n";
import { logDebug } from "./log";
import type { ProgressCallback } from "./progress";
import { createSummaryProvider, createTranscriptionProvider, resolveSummaryApiKey } from "./providers/factory";
import { summarizeLongTranscript } from "./providers/map-reduce-summarizer";
import { hasRepetitionLoop } from "./providers/repetition-detector";
import { RequestAbortedError } from "./providers/request-timeout";
import type { TranscriptionSegment } from "./providers/transcription";
import { AiTranscribeSummarySettings, SummaryMediaLinkMode, TranscriptOutputFormat, transcriptionKeyReuseTarget } from "./settings";
import { resolveSummaryPrompt } from "./summary-prompts";
import { filterTranscriptArtifacts } from "./transcript-artifact-filter";

export { RequestAbortedError };

export { logDebug };

export function formatTimestampForFilename(date: Date): string {
	const pad = (n: number) => n.toString().padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

export interface AudioSource {
	blob: Blob;
	mimeType: string;
	/** True for video containers, which must be decoded locally before their audio reaches Whisper. */
	extractAudio?: boolean;
	/** Base filename (no extension) used for the output note when there's no active note to insert into. */
	baseName: string;
	/** The saved/source media file in the vault, when one exists - used for result placement and summary links. Undefined when saveAudioFile is off for a live recording. */
	audioFile?: TFile;
	/** Filesystem path to the source file on disk when available. */
	filePath?: string;
}

/** True when a recording needs an actual transcription API call - either a transcript file is wanted or its text feeds summary generation. */
export function needsTranscription(settings: AiTranscribeSummarySettings): boolean {
	return settings.transcribeAudio || settings.generateSummary;
}

/** Checks required API keys are set before any request is made, so a misconfigured provider fails immediately with a clear message instead of mid-upload. */
export function validatePipelineConfig(settings: AiTranscribeSummarySettings): string | undefined {
	if (!needsTranscription(settings)) return undefined;

	const transcriptionConfig = settings.providers[settings.transcriptionProvider];
	if (!transcriptionConfig.apiKey) {
		const label = settings.transcriptionProvider === "openai" ? "OpenAI" : "OpenRouter";
		return t('{label} API key is not set. Add it in Settings under "{label}", or switch the transcription provider.', { label });
	}

	if (settings.generateSummary) {
		const configError = validateSummaryProviderConfig(settings);
		if (configError) return configError;
	}

	return undefined;
}

/** Same summary-provider API key check as validatePipelineConfig, but standalone - used by the text-summarization pipeline (note/selection), which never touches a transcription provider. */
export function validateSummaryProviderConfig(settings: AiTranscribeSummarySettings): string | undefined {
	const effectiveApiKey = resolveSummaryApiKey(settings, settings.summaryProvider);
	if (!effectiveApiKey) {
		const isReusingTranscriptionKey = settings.reuseWhisperKeyForSummary && transcriptionKeyReuseTarget(settings) === settings.summaryProvider;
		const hint = isReusingTranscriptionKey
			? t("Reuse is enabled, but the transcription API key is also empty - set one of the two keys")
			: t("Add it in Settings under Summary");
		return t("The {provider} API key is not set. {hint}.", { provider: settings.summaryProvider, hint });
	}
	return undefined;
}

/**
 * Runs audio -> transcript -> (optionally) summary and writes the output.
 * Shared by the live-recording stop handler and the right-click "Transcribe
 * & summarize" retry action; both pass the markdown note the user was last
 * editing (if any) via `options.targetView`, so the result lands at the
 * cursor there, falling back to a new note in the summary folder when
 * `targetView` is undefined (nothing was ever open). The caller must resolve
 * this itself from a live-updated cache rather than a workspace lookup taken
 * at call time - opening the right-click context menu moves the active leaf
 * to the file explorer before the click handler runs, so a lookup done here
 * (e.g. `workspace.activeEditor`/`getActiveViewOfType`) would already be too
 * late even though a note is still open on screen.
 *
 * settings.transcribeAudio and settings.generateSummary are independent toggles:
 * - transcribeAudio controls only whether a transcript file is written;
 *   it does NOT gate whether transcription happens.
 * - Transcription itself runs whenever transcribeAudio or generateSummary is on -
 *   summary/cleanup need transcript text even when the
 *   user doesn't want the raw transcript kept. See needsTranscription().
 * - cleanupTranscript only cleans the text passed into summary generation. Saved
 *   transcripts retain artifact-filtered provider output so timestamped formats stay aligned with audio.
 * - When both transcribeAudio and generateSummary are off, nothing downstream of
 *   transcription would ever be written, so transcription is skipped entirely and
 *   the recording is audio-only (targetView has no effect in that case).
 */
export function hashString(input: string): string {
	let hash = 2166136261;
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Computes a deterministic cache key representing the source audio and transcription parameters. */
export function computeTranscriptionCacheKey(source: AudioSource, settings: AiTranscribeSummarySettings): string {
	const providerId = settings.transcriptionProvider;
	const providerConfig = settings.providers[providerId];
	const model = providerConfig?.model ?? "";
	const lang = settings.transcriptionLanguage ?? "";
	const hints = settings.vocabularyHints ?? "";
	const maxMb = settings.whisperMaxFileSizeMb ?? 22;
	const sourceIdentifier = source.filePath ?? source.audioFile?.path ?? source.baseName;
	const sourceSize = source.audioFile?.stat?.size ?? source.blob.size;
	const sourceMtime = source.audioFile?.stat?.mtime ?? 0;

	const raw = `${sourceIdentifier}:${sourceSize}:${sourceMtime}:${providerId}:${model}:${lang}:${hints}:${maxMb}`;
	const hash = hashString(raw);
	const sanitized = source.baseName.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 24);
	return `${sanitized}-${hash}`;
}

export async function runTranscribeAndSummarizePipeline(
	app: App,
	settings: AiTranscribeSummarySettings,
	source: AudioSource,
	options: {
		targetView: MarkdownView | undefined;
		summaryPrompt?: string;
		onProgress?: ProgressCallback;
		signal?: AbortSignal;
		chunkCache?: import("./audio/chunk-cache").ChunkCache;
	}
): Promise<void> {
	const onProgress = options.onProgress ?? (() => {});
	const signal = options.signal;

	logDebug("pipeline started", {
		baseName: source.baseName,
		mimeType: source.mimeType,
		sizeBytes: source.blob.size,
		targetViewFile: options.targetView?.file?.path ?? null,
	});

	const configError = validatePipelineConfig(settings);
	if (configError) {
		logDebug("config validation failed", configError);
		throw new Error(configError);
	}

	if (!needsTranscription(settings)) {
		logDebug("pipeline finished (transcript/summary/cleanup all off, audio only)");
		new Notice(
			source.audioFile
				? t('Recording saved as "{name}" - transcription is off.', { name: source.baseName })
				: t('Recording finished - transcription is off, and "Save audio file" is also off, so nothing was kept.')
		);
		return;
	}

	// Captured up front, not after the transcription/summary calls - the user may switch notes
	// while those are in flight, and the result should land in the note that was active when
	// recording stopped, not whatever happens to be active when the LLM calls finish.
	// targetView comes from a cache in main.ts that can outlive the note it points to (closed
	// tab, deleted file) - confirm its leaf is still open before trusting it as an insert target.
	const targetLeafStillOpen = options.targetView && app.workspace.getLeavesOfType("markdown").some((leaf) => leaf.view === options.targetView);
	const activeView = targetLeafStillOpen ? options.targetView : undefined;

	const transcriptionProvider = createTranscriptionProvider(settings);
	logDebug("transcription provider resolved", transcriptionProvider.id);

	onProgress({ status: t("Transcribing") });
	new Notice(t('Transcribing "{name}"...', { name: source.baseName }));
	const transcribeStartedAt = Date.now();
	const filePath = source.filePath ?? (source.audioFile ? resolvePhysicalPath(app, source.audioFile) : undefined);
	const cacheKey = computeTranscriptionCacheKey(source, settings);
	const rawTranscription = await transcriptionProvider.transcribe({
		audio: source.blob,
		mimeType: source.mimeType,
		vocabularyHints: settings.vocabularyHints,
		language: settings.transcriptionLanguage,
		extractAudio: source.extractAudio,
		filePath,
		onProgress,
		signal,
		cacheKey,
		chunkCache: options.chunkCache,
	});
	const filteredTranscript = filterTranscriptArtifacts(
		rawTranscription.text,
		rawTranscription.segments,
		settings.excludedTranscriptPhrases
	);
	const transcription = {
		...rawTranscription,
		text: filteredTranscript.text,
		segments: filteredTranscript.segments,
		repetitionWarning:
			filteredTranscript.removedCount > 0 ? hasRepetitionLoop(filteredTranscript.text) : rawTranscription.repetitionWarning,
	};
	if (filteredTranscript.removedCount > 0) {
		logDebug("transcription artifacts excluded", { removedCount: filteredTranscript.removedCount });
	}
	logDebug("transcription finished", { durationMs: Date.now() - transcribeStartedAt, textLength: transcription.text.length, repetitionWarning: transcription.repetitionWarning });

	if (transcription.repetitionWarning) {
		new Notice(t('Warning: possible repetition-loop artifact detected in the transcript for "{name}".', { name: source.baseName }));
	}

	// From here on (cleanup, summary, writing the note) a failure would otherwise discard a
	// transcript that already cost a real transcription API call to produce. Catch it, save the
	// raw transcript immediately so that cost isn't wasted, and tell the user where it landed
	// instead of just surfacing the underlying error.
	// Tracks whether the transcript file write below actually completed - the rescue
	// path in the catch block uses this (rather than re-deriving it from settings) so it isn't
	// skipped when a failure happens before that write runs, e.g. during cleanup.
	let transcriptPath: string | undefined;
	try {
		if (settings.transcribeAudio) {
			onProgress({ status: t("Saving transcript") });
			transcriptPath = await writeTranscriptFile(app, settings, source.baseName, transcription.text, transcription.segments, source.audioFile);
		}

		if (!settings.generateSummary) {
			if (settings.transcribeAudio) {
				new Notice(t('Transcript ready for "{name}".', { name: source.baseName }));
			} else {
				new Notice(t('Recording processed for "{name}" - transcript and summary are both off, nothing was kept.', { name: source.baseName }));
			}
			if (options.chunkCache) await options.chunkCache.clear(cacheKey);
			logDebug("pipeline finished (transcript only, or nothing kept)");
			return;
		}

		let transcriptText = transcription.text;
		if (settings.cleanupTranscript) {
			const cleanupProvider = createSummaryProvider(settings);
			logDebug("cleanup provider resolved", cleanupProvider.id);

			onProgress({ status: t("Cleaning up transcript") });
			new Notice(t('Cleaning up transcript for "{name}"...', { name: source.baseName }));
			const cleanupStartedAt = Date.now();
			const cleanupResult = await cleanupProvider.summarize({
				transcript: transcriptText,
				prompt: settings.cleanupPrompt,
				signal,
				step: "cleanup",
			});
			logDebug("cleanup finished", { durationMs: Date.now() - cleanupStartedAt, textLength: cleanupResult.summary.length });
			transcriptText = cleanupResult.summary.trim() || transcriptText;
		}

		const summaryProvider = createSummaryProvider(settings);
		logDebug("summary provider resolved", summaryProvider.id);

		onProgress({ status: t("Generating summary") });
		new Notice(t('Generating summary for "{name}"...', { name: source.baseName }));
		const summarizeStartedAt = Date.now();
		const prompt = options.summaryPrompt ?? resolveSummaryPrompt(settings.summaryPrompts, settings.defaultSummaryPromptId).prompt;
		const summaryResult = await summarizeLongTranscript(summaryProvider, { transcript: transcriptText, prompt, signal }, onProgress);
		logDebug("summary finished", { durationMs: Date.now() - summarizeStartedAt, summaryLength: summaryResult.summary.length });

		const summaryMarkdown = buildSummaryMarkdown(summaryResult.summary, transcription.repetitionWarning);

		onProgress({ status: t("Saving results") });
		// Re-checked here rather than trusting the activeView captured above: transcription/cleanup/summary
		// are slow async calls, and the user may have switched away from that note (or it may just be a stale
		// background tab) by the time we're ready to write. Inserting into a note that's no longer on screen
		// would silently "lose" the summary from the user's point of view, so only insert inline when that
		// note is still the one actually focused right now; otherwise fall back to a new file and say why.
		// Skipped entirely when summaryPlacement is "dedicated-file" - the user has opted out of
		// active-note insertion regardless of what's currently focused.
		const stillActiveView =
			settings.summaryPlacement === "active-note" && activeView && app.workspace.getActiveViewOfType(MarkdownView) === activeView ? activeView : undefined;
		if (stillActiveView) {
			const mediaLinkMarkdown = source.audioFile
				? buildMediaLinkMarkdown(app, source.audioFile, stillActiveView.file?.path ?? "", settings.summaryMediaLinkMode)
				: "";
			writeIntoActiveNote(stillActiveView, `${mediaLinkMarkdown}${summaryMarkdown}`);
			await stillActiveView.save();
			await writeSummaryLinkProperties(app, stillActiveView, source.audioFile, transcriptPath);
		} else {
			if (settings.summaryPlacement === "active-note" && activeView) {
				const outputFolder = resolveResultFolder(settings.summaryFolder, source.audioFile, settings.saveResultsNextToSource) || t("the vault root");
				new Notice(t('Couldn\'t detect the note to insert into - creating a new file in "{folder}" instead.', { folder: outputFolder }));
			}
			await writeIntoNewNote(app, settings, source.baseName, summaryMarkdown, source.audioFile, transcriptPath);
		}

		if (options.chunkCache) await options.chunkCache.clear(cacheKey);
		new Notice(t('Summary ready for "{name}".', { name: source.baseName }));
		logDebug("pipeline finished (summary)");
	} catch (error) {
		const cancelled = error instanceof RequestAbortedError;
		logDebug(cancelled ? "pipeline cancelled after transcription, saving raw transcript" : "pipeline failed after transcription, saving raw transcript", error);
		// If the transcript was already written above before the failure, it's
		// already safe - don't also write a rescue copy alongside it.
		const rescuePath = transcriptPath ? undefined : await tryWriteRescueTranscript(app, settings, source, transcription.text, transcription.segments);

		if (cancelled) {
			throw new RequestAbortedError(rescuePath ? t('Stopped. The transcript so far was saved to "{path}".', { path: rescuePath }) : t("Stopped."));
		}

		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			rescuePath
				? `${message}\n\n${t('The transcript was already produced and has been saved to "{path}" so it isn\'t lost. Fix the issue above, then re-run "Transcribe & summarize" on the audio file - or use the saved transcript directly.', { path: rescuePath })}`
				: message,
			{ cause: error }
		);
	}
}

export interface TextSummarySource {
	/** The note/selection text to summarize. */
	text: string;
	/** Editor to write the result into - full-note commands pass the whole editor and insert at the cursor; the "Summarize selection" command passes the same editor and replaces the current selection instead. */
	editor: Editor;
	/** True to replace the current selection with the summary; false to insert at the cursor (used for whole-note summarization, where there is no meaningful selection to replace). */
	replaceSelection: boolean;
	/** Note being summarized, if any - used only for progress/error messages. */
	fileLabel: string;
}

/**
 * Summarizes arbitrary note/selection text directly - unlike
 * runTranscribeAndSummarizePipeline, there is no audio or transcription step:
 * the input text goes straight to the configured summary provider (reusing
 * the default named prompt/model/map-reduce chunking as meeting summaries) and
 * the result is written back into the same editor, either replacing the
 * selection or inserted at the cursor.
 */
export async function runSummarizeTextPipeline(
	settings: AiTranscribeSummarySettings,
	source: TextSummarySource,
	options: { onProgress?: ProgressCallback; signal?: AbortSignal }
): Promise<void> {
	const onProgress = options.onProgress ?? (() => {});
	const signal = options.signal;

	logDebug("text summary pipeline started", { fileLabel: source.fileLabel, textLength: source.text.length });

	const configError = validateSummaryProviderConfig(settings);
	if (configError) {
		logDebug("config validation failed", configError);
		throw new Error(configError);
	}

	if (!source.text.trim()) {
		throw new Error(t("There's no text to summarize."));
	}

	const summaryProvider = createSummaryProvider(settings);
	logDebug("summary provider resolved", summaryProvider.id);

	onProgress({ status: t("Generating summary") });
	new Notice(t('Generating summary for "{name}"...', { name: source.fileLabel }));
	const summarizeStartedAt = Date.now();
	const prompt = resolveSummaryPrompt(settings.summaryPrompts, settings.defaultSummaryPromptId).prompt;
	const summaryResult = await summarizeLongTranscript(summaryProvider, { transcript: source.text, prompt, signal }, onProgress);
	logDebug("summary finished", { durationMs: Date.now() - summarizeStartedAt, summaryLength: summaryResult.summary.length });

	const summaryMarkdown = buildSummaryMarkdown(summaryResult.summary, false);
	if (source.replaceSelection) {
		source.editor.replaceSelection(summaryMarkdown);
	} else {
		source.editor.replaceRange(summaryMarkdown, source.editor.getCursor());
	}

	new Notice(t('Summary ready for "{name}".', { name: source.fileLabel }));
	logDebug("text summary pipeline finished");
}

/** Best-effort rescue save of the uncleaned, artifact-filtered transcript after a post-transcription failure - swallows its own errors so a failure here doesn't replace the original, more useful error with an unrelated file-write one. Named "-raw" since it has not passed through LLM cleanup, whether or not cleanup was enabled - the failure may be cleanup itself failing. */
async function tryWriteRescueTranscript(
	app: App,
	settings: AiTranscribeSummarySettings,
	source: AudioSource,
	text: string,
	segments: TranscriptionSegment[]
): Promise<string | undefined> {
	try {
		const folderPath = resolveResultFolder(settings.transcriptFolder, source.audioFile, settings.saveResultsNextToSource);
		await ensureFolder(app, folderPath);
		const transcriptName = applyFileNameTemplate(settings.transcriptFileNameTemplate, source.baseName);
		const extension = transcriptFileExtension(settings.transcriptOutputFormat);
		const rescuePath = resolveNonCollidingPathWithExtension(app, folderPath, `${transcriptName}-raw`, extension);
		await app.vault.create(rescuePath, buildTranscriptContent(text, segments, settings.transcriptOutputFormat));
		logDebug("rescue transcript written", { path: rescuePath });
		return rescuePath;
	} catch (rescueError) {
		logDebug("rescue transcript save also failed", rescueError);
		return undefined;
	}
}

function buildSummaryMarkdown(summary: string, repetitionWarning: boolean): string {
	const warning = repetitionWarning
		? `> [!warning] ${t("Possible repetition-loop artifact detected in the transcript - review before trusting this summary.")}\n\n`
		: "";
	return `${warning}${summary.trim()}\n`;
}

export function buildTranscriptJson(segments: TranscriptionSegment[]): string {
	return `${JSON.stringify({ segments }, null, 2)}\n`;
}

export function formatTranscriptTimestamp(seconds: number): string {
	const totalSeconds = Math.max(0, Math.floor(seconds));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const remainingSeconds = totalSeconds % 60;
	const clock = `${minutes.toString().padStart(2, "0")}:${remainingSeconds.toString().padStart(2, "0")}`;
	return hours > 0 ? `${hours.toString().padStart(2, "0")}:${clock}` : clock;
}

export function buildTimestampedTranscriptMarkdown(segments: TranscriptionSegment[]): string {
	const lines = segments.map(
		(segment) => `**[${formatTranscriptTimestamp(segment.start)} – ${formatTranscriptTimestamp(segment.end)}]** ${segment.text.trim()}`
	);
	return `${t("## Full Transcript")}\n\n${lines.join("\n\n")}\n`;
}

export function transcriptFileExtension(format: TranscriptOutputFormat): "md" | "json" {
	return format === "json" ? "json" : "md";
}

export function buildTranscriptContent(text: string, segments: TranscriptionSegment[], format: TranscriptOutputFormat): string {
	if (format === "text") return `${t("## Full Transcript")}\n\n${text.trim()}\n`;
	if (format === "markdown") return buildTimestampedTranscriptMarkdown(segments);
	return buildTranscriptJson(segments);
}

export function formatMediaLink(link: string, mode: SummaryMediaLinkMode): string {
	if (mode === "none") return "";
	return mode === "embed" ? `!${link}` : link;
}

type SummaryMediaFile = Pick<TFile, "path" | "extension">;

export function buildSummaryLinkProperties(mediaFile: SummaryMediaFile | undefined, transcriptPath: string | undefined): Record<string, string> {
	const properties: Record<string, string> = {};
	if (mediaFile) properties[isVideoFile(mediaFile) ? "video" : "audio"] = `[[${mediaFile.path}]]`;
	if (transcriptPath) properties.transcript = `[[${transcriptPath}]]`;
	return properties;
}

export function buildSummaryFrontmatter(mediaFile: SummaryMediaFile | undefined, transcriptPath: string | undefined): string {
	const properties = Object.entries(buildSummaryLinkProperties(mediaFile, transcriptPath));
	if (properties.length === 0) return "";
	const yaml = properties.map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n");
	return `---\n${yaml}\n---\n\n`;
}

/** `sourcePath` must be the final note path so relative Markdown links remain correct. */
function buildMediaLinkMarkdown(app: App, mediaFile: TFile, sourcePath: string, mode: SummaryMediaLinkMode): string {
	if (mode === "none") return "";
	const link = app.fileManager.generateMarkdownLink(mediaFile, sourcePath);
	return `${formatMediaLink(link, mode)}\n\n`;
}

function writeIntoActiveNote(view: MarkdownView, summaryMarkdown: string): void {
	view.editor.replaceSelection(summaryMarkdown);
	logDebug("summary inserted into active note", { path: view.file?.path ?? null });
}

async function writeSummaryLinkProperties(
	app: App,
	view: MarkdownView,
	mediaFile: TFile | undefined,
	transcriptPath: string | undefined
): Promise<void> {
	if (!view.file) return;
	const properties = buildSummaryLinkProperties(mediaFile, transcriptPath);
	if (Object.keys(properties).length === 0) return;
	await app.fileManager.processFrontMatter(view.file, (frontmatter) => {
		for (const [key, value] of Object.entries(properties)) {
			const existing = frontmatter[key];
			if (existing === undefined || existing === null) frontmatter[key] = value;
			else if (Array.isArray(existing) && !existing.includes(value)) existing.push(value);
			else if (typeof existing === "string" && existing !== value) frontmatter[key] = [existing, value];
		}
	});
}

async function writeIntoNewNote(
	app: App,
	settings: AiTranscribeSummarySettings,
	baseName: string,
	summaryMarkdown: string,
	audioFile: TFile | undefined,
	transcriptPath: string | undefined
): Promise<string> {
	const folderPath = resolveResultFolder(settings.summaryFolder, audioFile, settings.saveResultsNextToSource);
	await ensureFolder(app, folderPath);

	const notePath = resolveNonCollidingPath(app, folderPath, applyFileNameTemplate(settings.summaryFileNameTemplate, baseName));
	const mediaLinkMarkdown = audioFile ? buildMediaLinkMarkdown(app, audioFile, notePath, settings.summaryMediaLinkMode) : "";
	const frontmatter = buildSummaryFrontmatter(audioFile, transcriptPath);
	await app.vault.create(notePath, `${frontmatter}${mediaLinkMarkdown}${summaryMarkdown}`);
	logDebug("summary written to new note", { path: notePath });
	return notePath;
}

async function writeTranscriptFile(
	app: App,
	settings: AiTranscribeSummarySettings,
	baseName: string,
	text: string,
	segments: TranscriptionSegment[],
	audioFile: TFile | undefined
): Promise<string> {
	const folderPath = resolveResultFolder(settings.transcriptFolder, audioFile, settings.saveResultsNextToSource);
	await ensureFolder(app, folderPath);
	const format = settings.transcriptOutputFormat;
	const transcriptPath = resolveNonCollidingPathWithExtension(
		app,
		folderPath,
		applyFileNameTemplate(settings.transcriptFileNameTemplate, baseName),
		transcriptFileExtension(format)
	);
	await app.vault.create(transcriptPath, buildTranscriptContent(text, segments, format));
	logDebug("transcript written to new note", { path: transcriptPath });
	return transcriptPath;
}

/** Expands every source-name token so users can place the original audio name anywhere in an output filename. */
export function applyFileNameTemplate(template: string, sourceName: string): string {
	return template.replaceAll("{name}", sourceName);
}

/** Uses the source file's vault-relative parent when requested, while retaining configured folders for unsaved live recordings. */
export function resolveResultFolder(configuredFolder: string, audioFile: TFile | undefined, saveNextToSource: boolean): string {
	if (saveNextToSource && audioFile) {
		const separatorIndex = audioFile.path.lastIndexOf("/");
		return separatorIndex === -1 ? "" : audioFile.path.slice(0, separatorIndex);
	}
	return normalizePath(configuredFolder);
}

/** `<folderPath>/<baseName>.md`, or the same with a timestamp appended if that path is already taken - so re-running "Transcribe & summarize" on the same audio file creates a new note instead of throwing on Vault.create(). */
export function resolveNonCollidingPath(app: App, folderPath: string, baseName: string): string {
	const notePath = normalizePath(`${folderPath}/${baseName}.md`);
	if (!app.vault.getAbstractFileByPath(notePath)) {
		return notePath;
	}
	return normalizePath(`${folderPath}/${baseName} ${formatTimestampForFilename(new Date())}.md`);
}

/** Same collision-avoidance as resolveNonCollidingPath, but for an arbitrary extension (used for saved audio recordings) rather than always ".md". A custom file-name template without a time component makes a same-second collision much more likely than the old fixed "meeting <timestamp>" scheme did, so this is worth having even though it wasn't needed before. */
export function resolveNonCollidingPathWithExtension(app: App, folderPath: string, baseName: string, extension: string): string {
	const filePath = normalizePath(`${folderPath}/${baseName}.${extension}`);
	if (!app.vault.getAbstractFileByPath(filePath)) {
		return filePath;
	}
	return normalizePath(`${folderPath}/${baseName} ${formatTimestampForFilename(new Date())}.${extension}`);
}

async function ensureFolder(app: App, folderPath: string): Promise<void> {
	if (!folderPath || folderPath === "/") return;
	const existing = app.vault.getAbstractFileByPath(folderPath);
	if (!existing) {
		await app.vault.createFolder(folderPath);
	} else if (!(existing instanceof TFolder)) {
		throw new Error(t('"{path}" exists but is not a folder.', { path: folderPath }));
	}
}

export function isAudioFile(file: Pick<TFile, "extension">): boolean {
	return ["webm", "ogg", "mp3", "wav", "m4a"].includes(file.extension.toLowerCase());
}

export function isVideoFile(file: Pick<TFile, "extension">): boolean {
	return ["mp4", "mov", "m4v", "mkv", "avi", "mpg", "mpeg"].includes(file.extension.toLowerCase());
}

export function isSupportedMediaFile(file: TFile): boolean {
	return isAudioFile(file) || isVideoFile(file);
}

/** Resolves the absolute filesystem path for a vault file on desktop, if supported by the vault adapter. */
export function resolvePhysicalPath(app: App, file: TFile): string | undefined {
	try {
		const adapter = app.vault.adapter;
		if (adapter && "getFullPath" in adapter && typeof (adapter as { getFullPath?: unknown }).getFullPath === "function") {
			return (adapter as { getFullPath: (path: string) => string }).getFullPath(file.path);
		}
		if (adapter && "getBasePath" in adapter && typeof (adapter as { getBasePath?: unknown }).getBasePath === "function") {
			const basePath = (adapter as { getBasePath: () => string }).getBasePath();
			return `${basePath}/${file.path}`;
		}
	} catch {
		// Mock environment or non-filesystem adapter
	}
	return undefined;
}
