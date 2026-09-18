import { App, Modal, Notice, setIcon, Setting } from "obsidian";
import type { ErrorTracker, RecordedError } from "./error-tracker";
import { t } from "./i18n";

function formatErrorText(error: RecordedError): string {
	const time = new Date(error.timestamp).toLocaleString();
	const source = error.sourceName ? ` [${error.sourceName}]` : "";
	let text = `[${time}] ${error.action}${source}\n${error.message}`;
	if (error.details) {
		text += `\n\nDetails:\n${error.details}`;
	}
	return text;
}

export class ErrorLogModal extends Modal {
	constructor(app: App, private errorTracker: ErrorTracker) {
		super(app);
	}

	onOpen(): void {
		this.render();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private render(): void {
		const container = this.contentEl;
		container.empty();
		container.addClass("ai-transcribe-summary-error-modal");

		const errors = this.errorTracker.getErrors();

		const headerEl = container.createDiv({ cls: "ai-transcribe-summary-error-modal-header" });
		headerEl.createEl("h3", { text: t("Error log") });
		headerEl.createSpan({
			cls: "ai-transcribe-summary-task-count",
			text: errors.length.toString(),
		});

		const actionsEl = container.createDiv({ cls: "ai-transcribe-summary-error-modal-actions" });

		if (errors.length > 0) {
			const copyAllBtn = actionsEl.createEl("button", {
				cls: "mod-cta",
				text: t("Copy all"),
			});
			copyAllBtn.addEventListener("click", async () => {
				const fullLog = errors.map(formatErrorText).join("\n\n" + "=".repeat(40) + "\n\n");
				await navigator.clipboard.writeText(fullLog);
				new Notice(t("All errors copied to clipboard"));
			});

			const clearBtn = actionsEl.createEl("button", {
				cls: "mod-warning",
				text: t("Clear log"),
			});
			clearBtn.addEventListener("click", async () => {
				await this.errorTracker.clear();
				this.render();
			});
		}

		if (errors.length === 0) {
			const emptyEl = container.createDiv({ cls: "ai-transcribe-summary-task-empty" });
			const icon = emptyEl.createDiv({ cls: "ai-transcribe-summary-task-empty-icon" });
			setIcon(icon, "circle-check-big");
			emptyEl.createEl("p", { text: t("No errors recorded") });
			return;
		}

		const listEl = container.createDiv({ cls: "ai-transcribe-summary-error-list" });
		for (const error of errors) {
			const item = listEl.createDiv({ cls: "ai-transcribe-summary-error-item" });

			const topRow = item.createDiv({ cls: "ai-transcribe-summary-error-top" });
			const meta = topRow.createDiv({ cls: "ai-transcribe-summary-error-meta" });
			meta.createSpan({
				cls: "ai-transcribe-summary-error-time",
				text: new Date(error.timestamp).toLocaleString(),
			});
			if (error.sourceName) {
				meta.createSpan({
					cls: "ai-transcribe-summary-error-source",
					text: error.sourceName,
				});
			}

			const copyBtn = topRow.createEl("button", {
				cls: "clickable-icon ai-transcribe-summary-error-copy",
				attr: { "aria-label": t("Copy error") },
			});
			setIcon(copyBtn, "copy");
			copyBtn.addEventListener("click", async () => {
				await navigator.clipboard.writeText(formatErrorText(error));
				new Notice(t("Error copied to clipboard"));
			});

			item.createDiv({
				cls: "ai-transcribe-summary-error-message",
				text: error.message,
			});

			if (error.details) {
				const detailsEl = item.createEl("pre", {
					cls: "ai-transcribe-summary-error-details",
					text: error.details,
				});
			}
		}
	}
}
