import { App, normalizePath } from "obsidian";
import { logDebug } from "./log";

export interface RecordedError {
	id: string;
	timestamp: number;
	action: string;
	sourceName?: string;
	message: string;
	details?: string;
}

const MAX_STORED_ERRORS = 50;

/**
 * Persists errors across plugin/app restarts so transient notifications aren't the only place
 * an error message was seen, enabling users to inspect, copy, and diagnose failure details later.
 */
export class ErrorTracker {
	private errors: RecordedError[] = [];
	private listeners = new Set<() => void>();
	private loaded = false;
	private persistChain = Promise.resolve();

	constructor(private app: App) {}

	private getFilePath(): string {
		const configDir = this.app.vault?.configDir ?? ".obsidian";
		return normalizePath(`${configDir}/plugins/ai-transcribe-summary/errors.json`);
	}

	async load(): Promise<void> {
		if (this.loaded) return;
		this.loaded = true;

		const adapter = this.app.vault?.adapter;
		if (!adapter) return;

		const filePath = this.getFilePath();
		try {
			if (await adapter.exists(filePath)) {
				const content = await adapter.read(filePath);
				const parsed = JSON.parse(content);
				if (Array.isArray(parsed)) {
					this.errors = parsed.filter(
						(e): e is RecordedError =>
							typeof e?.id === "string" &&
							typeof e?.timestamp === "number" &&
							typeof e?.message === "string" &&
							typeof e?.action === "string"
					);
				}
			}
		} catch (error) {
			logDebug(`failed to load error log file "${filePath}"`, error);
		}
	}

	getErrors(): readonly RecordedError[] {
		return this.errors;
	}

	getLatestError(): RecordedError | undefined {
		return this.errors[0];
	}

	recordError(action: string, error: unknown, sourceName?: string): RecordedError {
		const message = error instanceof Error ? error.message : String(error);
		let details: string | undefined;
		if (error instanceof Error && error.stack && error.stack !== error.message) {
			details = error.stack;
		} else if (typeof error === "object" && error !== null) {
			try {
				details = JSON.stringify(error, null, 2);
			} catch {
				// Non-serializable details
			}
		}

		const record: RecordedError = {
			id: `err-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
			timestamp: Date.now(),
			action,
			sourceName,
			message,
			details,
		};

		this.errors.unshift(record);
		if (this.errors.length > MAX_STORED_ERRORS) {
			this.errors.length = MAX_STORED_ERRORS;
		}

		this.notify();
		void this.persist();
		return record;
	}

	async clear(): Promise<void> {
		this.errors = [];
		this.notify();
		await this.persist();
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private notify(): void {
		for (const listener of this.listeners) {
			try {
				listener();
			} catch (err) {
				console.error("ai-transcribe-summary: error tracker listener failed", err);
			}
		}
	}

	async persist(): Promise<void> {
		this.persistChain = this.persistChain
			.catch(() => {})
			.then(async () => {
				const adapter = this.app.vault?.adapter;
				if (!adapter) return;

				const filePath = this.getFilePath();
				const parentDir = filePath.slice(0, filePath.lastIndexOf("/"));
				try {
					if (parentDir && !(await adapter.exists(parentDir))) {
						await adapter.mkdir(parentDir);
					}
					await adapter.write(filePath, JSON.stringify(this.errors, null, 2));
				} catch (error) {
					logDebug(`failed to save error log to "${filePath}"`, error);
				}
			});
		await this.persistChain;
	}
}
