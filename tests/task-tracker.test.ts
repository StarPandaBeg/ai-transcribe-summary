import { describe, expect, it, vi } from "vitest";
import { TaskTracker } from "../src/task-tracker";

describe("TaskTracker", () => {
	it("publishes task lifecycle changes and preserves insertion order", () => {
		const tracker = new TaskTracker();
		const listener = vi.fn();
		const unsubscribe = tracker.subscribe(listener);

		tracker.start({ id: "first", kind: "pipeline", title: "First", status: "Starting", startedAt: 1, canCancel: true });
		tracker.start({ id: "second", kind: "recording", title: "Recording", status: "Recording", startedAt: 2, canCancel: true });
		tracker.update("first", { status: "Transcribing" });

		expect(tracker.getTasks().map((task) => task.id)).toEqual(["first", "second"]);
		expect(tracker.getTasks()[0].status).toBe("Transcribing");

		tracker.finish("first");
		expect(tracker.getTasks().map((task) => task.id)).toEqual(["second"]);
		expect(listener).toHaveBeenCalledTimes(5);

		unsubscribe();
		tracker.finish("second");
		expect(listener).toHaveBeenCalledTimes(5);
	});

	it("ignores updates and finishes for unknown tasks", () => {
		const tracker = new TaskTracker();
		const listener = vi.fn();
		tracker.subscribe(listener);

		tracker.update("missing", { status: "Ignored" });
		tracker.finish("missing");

		expect(listener).toHaveBeenCalledTimes(1);
		expect(tracker.getTasks()).toEqual([]);
	});
});
