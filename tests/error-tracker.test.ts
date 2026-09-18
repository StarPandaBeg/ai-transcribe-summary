import { describe, expect, it, vi } from "vitest";
import { ErrorTracker } from "../src/error-tracker";
import type { App } from "obsidian";

function createMockApp(initialFiles: Record<string, string> = {}) {
	const files = new Map<string, string>(Object.entries(initialFiles));
	const dirs = new Set<string>();

	const adapter = {
		exists: async (path: string) => files.has(path) || dirs.has(path),
		read: async (path: string) => {
			const content = files.get(path);
			if (content === undefined) throw new Error(`File not found: ${path}`);
			return content;
		},
		write: async (path: string, data: string) => {
			files.set(path, data);
		},
		remove: async (path: string) => {
			files.delete(path);
		},
		mkdir: async (path: string) => {
			dirs.add(path);
		},
	};

	return {
		app: {
			vault: {
				configDir: ".obsidian",
				adapter,
			},
		} as unknown as App,
		files,
	};
}

describe("ErrorTracker", () => {
	it("records errors, preserves details, and notifies listeners", async () => {
		const { app, files } = createMockApp();
		const tracker = new ErrorTracker(app);
		const listener = vi.fn();
		tracker.subscribe(listener);

		const testError = new Error("Network timeout");
		const record = tracker.recordError("transcribe", testError, "meeting.mp4");

		expect(record.action).toBe("transcribe");
		expect(record.sourceName).toBe("meeting.mp4");
		expect(record.message).toBe("Network timeout");
		expect(record.details).toContain("Error: Network timeout");
		expect(tracker.getErrors()).toHaveLength(1);
		expect(tracker.getLatestError()).toBe(record);
		expect(listener).toHaveBeenCalledTimes(1);

		// Verify file persistence
		await tracker.persist();
		const filePath = ".obsidian/plugins/ai-transcribe-summary/errors.json";
		expect(files.has(filePath)).toBe(true);
	});

	it("caps stored errors at 50", () => {
		const { app } = createMockApp();
		const tracker = new ErrorTracker(app);

		for (let i = 0; i < 60; i++) {
			tracker.recordError("action", new Error(`Error ${i}`));
		}

		expect(tracker.getErrors()).toHaveLength(50);
		expect(tracker.getErrors()[0].message).toBe("Error 59");
		expect(tracker.getErrors()[49].message).toBe("Error 10");
	});

	it("loads persisted errors on load()", async () => {
		const initialErrors = [
			{ id: "err-1", timestamp: 1000, action: "transcribe", message: "Initial failure" },
		];
		const { app } = createMockApp({
			".obsidian/plugins/ai-transcribe-summary/errors.json": JSON.stringify(initialErrors),
		});

		const tracker = new ErrorTracker(app);
		await tracker.load();

		expect(tracker.getErrors()).toHaveLength(1);
		expect(tracker.getErrors()[0].message).toBe("Initial failure");
	});

	it("clears errors and notifies listeners", async () => {
		const { app, files } = createMockApp();
		const tracker = new ErrorTracker(app);

		tracker.recordError("test", new Error("boom"));
		expect(tracker.getErrors()).toHaveLength(1);

		await tracker.clear();
		expect(tracker.getErrors()).toHaveLength(0);
		expect(tracker.getLatestError()).toBeUndefined();
	});
});
