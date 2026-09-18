import { describe, expect, it, vi } from "vitest";
import { TaskTracker } from "../src/task-tracker";

describe("TaskTracker", () => {
	it("publishes task lifecycle changes and preserves insertion order", () => {
		const tracker = new TaskTracker();
		const listener = vi.fn();
		const unsubscribe = tracker.subscribe(listener);

		tracker.start({ id: "first", kind: "pipeline", title: "First", status: "Starting", startedAt: 1, canCancel: true });
		tracker.start({ id: "second", kind: "recording", title: "Recording", status: "Recording", startedAt: 2, canCancel: true });
		tracker.update("first", { status: "Transcribing", progress: { completed: 2, total: 5, unit: "chunks" } });

		expect(tracker.getTasks().map((task) => task.id)).toEqual(["first", "second"]);
		expect(tracker.getTasks()[0].status).toBe("Transcribing");
		expect(tracker.getTasks()[0].progress).toEqual({ completed: 2, total: 5, unit: "chunks" });

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

	it("checks task presence with hasTask", () => {
		const tracker = new TaskTracker();
		expect(tracker.hasTask("job-1")).toBe(false);

		tracker.start({ id: "job-1", kind: "pipeline", title: "Job 1", status: "Starting", startedAt: 1, canCancel: true });
		expect(tracker.hasTask("job-1")).toBe(true);

		tracker.finish("job-1");
		expect(tracker.hasTask("job-1")).toBe(false);
	});

	it("isolates errors in listeners so other listeners continue to receive notifications", () => {
		const tracker = new TaskTracker();
		const badListener = vi.fn().mockImplementation(() => {
			throw new Error("listener error");
		});
		const goodListener = vi.fn();

		tracker.subscribe(badListener);
		tracker.subscribe(goodListener);

		expect(() => {
			tracker.start({ id: "safe", kind: "pipeline", title: "Safe", status: "Starting", startedAt: 1, canCancel: true });
		}).not.toThrow();

		expect(goodListener).toHaveBeenCalled();
	});
});
