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

	it("removes a failed attempt before starting its retry", () => {
		const tracker = new TaskTracker();
		const retryAction = vi.fn(() => {
			expect(tracker.hasTask("job-1")).toBe(false);
			tracker.start({ id: "job-2", kind: "pipeline", title: "Job 1", status: "Starting", startedAt: 2, canCancel: true });
		});

		tracker.start({ id: "job-1", kind: "pipeline", title: "Job 1", status: "Starting", startedAt: 1, canCancel: true });
		tracker.fail("job-1", "Upload failed", "HTTP 500 error", retryAction);

		const task = tracker.getTasks()[0];
		expect(task.error).toBe("Upload failed");
		expect(task.errorDetails).toBe("HTTP 500 error");
		expect(task.canCancel).toBe(false);
		expect(task.canRetry).toBe(true);
		expect(task.progress).toBeUndefined();

		expect(tracker.retry("job-1")).toBe(true);
		expect(retryAction).toHaveBeenCalledTimes(1);
		expect(tracker.getTasks().map((item) => item.id)).toEqual(["job-2"]);

		tracker.dismiss("job-2");
		expect(tracker.getTasks()).toEqual([]);
	});

	it("ignores repeated retries for the same failed attempt", () => {
		const tracker = new TaskTracker();
		const retryAction = vi.fn();
		tracker.start({ id: "job-1", kind: "pipeline", title: "Job 1", status: "Starting", startedAt: 1, canCancel: true });
		tracker.fail("job-1", "Upload failed", undefined, retryAction);

		expect(tracker.retry("job-1")).toBe(true);
		expect(tracker.retry("job-1")).toBe(false);
		expect(retryAction).toHaveBeenCalledTimes(1);
		expect(tracker.getTasks()).toEqual([]);
	});

	it("clears failed tasks with clearFailed", () => {
		const tracker = new TaskTracker();
		tracker.start({ id: "active", kind: "pipeline", title: "Active", status: "Running", startedAt: 1, canCancel: true });
		tracker.start({ id: "failed", kind: "pipeline", title: "Failed", status: "Starting", startedAt: 2, canCancel: true });
		tracker.fail("failed", "Error");

		expect(tracker.getTasks()).toHaveLength(2);
		tracker.clearFailed();
		expect(tracker.getTasks().map((t) => t.id)).toEqual(["active"]);
	});
});
