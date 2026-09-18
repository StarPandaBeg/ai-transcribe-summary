import { ItemView, Notice, setIcon, WorkspaceLeaf } from "obsidian";
import { t } from "./i18n";
import { TaskTracker, TrackedTask } from "./task-tracker";

export const TASK_CENTER_VIEW_TYPE = "ai-transcribe-summary-task-center";

export interface TaskCenterActions {
	cancelTask(id: string): void;
	stopRecording(): void;
	openErrorLog?(): void;
	retryTask?(id: string): void;
	dismissTask?(id: string): void;
}

function formatDuration(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	const pad = (value: number) => value.toString().padStart(2, "0");
	return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

/** A persistent workspace view over the shared tracker, allowing background jobs to remain visible while the user works elsewhere. */
export class TaskCenterView extends ItemView {
	private unsubscribe: (() => void) | undefined;
	private timerId: number | undefined;

	constructor(leaf: WorkspaceLeaf, private tracker: TaskTracker, private actions: TaskCenterActions) {
		super(leaf);
	}

	getViewType(): string {
		return TASK_CENTER_VIEW_TYPE;
	}

	getDisplayText(): string {
		return t("AI tasks");
	}

	getIcon(): string {
		return "list-checks";
	}

	async onOpen(): Promise<void> {
		this.ensureSubscribed();
		this.render();
		this.syncTimer();
	}

	async onClose(): Promise<void> {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.stopTimer();
	}

	onResize(): void {
		super.onResize();
		this.ensureSubscribed();
		this.render();
		this.syncTimer();
	}

	refresh(): void {
		this.ensureSubscribed();
		this.render();
		this.syncTimer();
	}

	private ensureSubscribed(): void {
		if (this.unsubscribe) return;
		this.unsubscribe = this.tracker.subscribe(() => {
			this.render();
			this.syncTimer();
		});
	}

	private syncTimer(): void {
		const hasActiveTasks = this.tracker.getTasks().some((task) => !task.error);
		if (hasActiveTasks && this.timerId === undefined) {
			const viewWindow = this.contentEl.ownerDocument.defaultView ?? window;
			this.timerId = viewWindow.setInterval(() => this.render(), 1000);
		} else if (!hasActiveTasks) {
			this.stopTimer();
		}
	}

	private stopTimer(): void {
		if (this.timerId === undefined) return;
		const viewWindow = this.contentEl.ownerDocument.defaultView ?? window;
		viewWindow.clearInterval(this.timerId);
		this.timerId = undefined;
	}

	private render(): void {
		const tasks = this.tracker.getTasks();
		const container = this.contentEl;
		container.empty();
		container.addClass("ai-transcribe-summary-task-center");

		const header = container.createDiv({ cls: "ai-transcribe-summary-task-header" });
		header.createEl("h4", { text: t("Current tasks") });
		header.createSpan({
			cls: "ai-transcribe-summary-task-count",
			text: tasks.length.toString(),
			attr: { "aria-label": t("Active tasks: {count}", { count: tasks.length }) },
		});

		if (this.actions.openErrorLog) {
			const errorLogBtn = header.createEl("button", {
				cls: "clickable-icon ai-transcribe-summary-task-error-log-btn",
				attr: { "aria-label": t("Open error log") },
			});
			setIcon(errorLogBtn, "alert-circle");
			errorLogBtn.addEventListener("click", () => this.actions.openErrorLog?.());
		}

		if (tasks.length === 0) {
			const empty = container.createDiv({ cls: "ai-transcribe-summary-task-empty" });
			const icon = empty.createDiv({ cls: "ai-transcribe-summary-task-empty-icon" });
			setIcon(icon, "circle-check-big");
			empty.createEl("p", { text: t("No tasks are running") });
			empty.createEl("small", { text: t("Recording, transcription, and summary progress will appear here.") });
			return;
		}

		const list = container.createDiv({ cls: "ai-transcribe-summary-task-list" });
		for (const task of tasks) {
			try {
				this.renderTask(list, task);
			} catch (error) {
				console.error("ai-transcribe-summary: failed to render task card", error);
			}
		}
	}

	private renderTask(list: HTMLElement, task: TrackedTask): void {
		const isError = Boolean(task.error);
		const card = list.createDiv({ cls: `ai-transcribe-summary-task-card${isError ? " is-error" : ""}` });

		const iconClass = isError ? "is-error" : `is-${task.kind}`;
		const icon = card.createDiv({ cls: `ai-transcribe-summary-task-icon ${iconClass}` });
		if (isError) {
			setIcon(icon, "alert-triangle");
		} else {
			setIcon(icon, task.kind === "recording" ? "mic" : "sparkles");
		}

		const details = card.createDiv({ cls: "ai-transcribe-summary-task-details" });
		details.createDiv({ cls: "ai-transcribe-summary-task-title", text: task.title });

		const status = details.createDiv({ cls: `ai-transcribe-summary-task-status${isError ? " is-error" : ""}` });
		if (!task.progress && !isError) {
			status.createSpan({ cls: "ai-transcribe-summary-task-spinner", attr: { "aria-hidden": "true" } });
		}
		status.createSpan({ text: isError ? t("Failed") : task.status });

		if (isError && task.error) {
			const errorBox = details.createDiv({ cls: "ai-transcribe-summary-task-error-box" });
			errorBox.createSpan({ text: task.error });
		}

		if (task.progress && !isError) {
			const percentage = Math.round((task.progress.completed / task.progress.total) * 100);
			const progressHeader = details.createDiv({ cls: "ai-transcribe-summary-progress-header" });
			const unit = t(task.progress.unit ?? "steps");
			progressHeader.createSpan({ text: `${task.progress.completed} / ${task.progress.total} ${unit}` });
			progressHeader.createSpan({ text: `${percentage}%` });
			const progressBar = details.createDiv({
				cls: "ai-transcribe-summary-progress-track",
				attr: {
					role: "progressbar",
					"aria-label": task.status,
					"aria-valuemin": "0",
					"aria-valuemax": task.progress.total.toString(),
					"aria-valuenow": task.progress.completed.toString(),
				},
			});
			progressBar.createDiv({ cls: "ai-transcribe-summary-progress-fill" }).style.setProperty("width", `${percentage}%`);
		}

		const elapsedMs = (task.completedAt ?? Date.now()) - task.startedAt;
		details.createDiv({ cls: "ai-transcribe-summary-task-elapsed", text: t("Elapsed {duration}", { duration: formatDuration(elapsedMs) }) });

		const actionsContainer = card.createDiv({ cls: "ai-transcribe-summary-task-card-actions" });

		if (isError) {
			if (task.canRetry && task.retryAction) {
				const retryBtn = actionsContainer.createEl("button", {
					cls: "clickable-icon ai-transcribe-summary-task-action-btn",
					attr: { "aria-label": t("Retry") },
				});
				setIcon(retryBtn, "rotate-cw");
				retryBtn.addEventListener("click", () => {
					this.tracker.update(task.id, { error: undefined, errorDetails: undefined, status: t("Starting") });
					task.retryAction?.();
				});
			}

			const copyBtn = actionsContainer.createEl("button", {
				cls: "clickable-icon ai-transcribe-summary-task-action-btn",
				attr: { "aria-label": t("Copy error") },
			});
			setIcon(copyBtn, "copy");
			copyBtn.addEventListener("click", async () => {
				const text = `${task.title}\n${task.error}${task.errorDetails ? `\n\n${task.errorDetails}` : ""}`;
				await navigator.clipboard.writeText(text);
				new Notice(t("Error copied to clipboard"));
			});

			const dismissBtn = actionsContainer.createEl("button", {
				cls: "clickable-icon ai-transcribe-summary-task-action-btn",
				attr: { "aria-label": t("Dismiss") },
			});
			setIcon(dismissBtn, "x");
			dismissBtn.addEventListener("click", () => {
				this.actions.dismissTask ? this.actions.dismissTask(task.id) : this.tracker.dismiss(task.id);
			});
		} else if (task.canCancel) {
			const button = actionsContainer.createEl("button", {
				cls: "clickable-icon ai-transcribe-summary-task-cancel",
				attr: { "aria-label": t(task.kind === "recording" ? "Stop recording" : "Stop task") },
			});
			setIcon(button, "square");
			button.addEventListener("click", () => {
				if (task.kind === "recording") this.actions.stopRecording();
				else this.actions.cancelTask(task.id);
			});
		}
	}
}
