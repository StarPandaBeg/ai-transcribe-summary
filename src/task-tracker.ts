export type TaskKind = "recording" | "pipeline";

export interface TaskProgress {
	completed: number;
	total: number;
	unit?: "chunks" | "steps";
}

export interface TrackedTask {
	id: string;
	kind: TaskKind;
	title: string;
	status: string;
	startedAt: number;
	canCancel: boolean;
	progress?: TaskProgress;
	error?: string;
	errorDetails?: string;
	canRetry?: boolean;
	retryAction?: () => void;
	completedAt?: number;
}

export type TaskTrackerListener = (tasks: readonly TrackedTask[]) => void;

/** Keeps transient work state outside the Obsidian view so closing and reopening the pane never loses active tasks. */
export class TaskTracker {
	private tasks = new Map<string, TrackedTask>();
	private listeners = new Set<TaskTrackerListener>();

	getTasks(): readonly TrackedTask[] {
		return [...this.tasks.values()];
	}

	start(task: TrackedTask): void {
		this.tasks.set(task.id, task);
		this.notify();
	}

	update(
		id: string,
		changes: Partial<Pick<TrackedTask, "status" | "title" | "canCancel" | "progress" | "error" | "errorDetails" | "canRetry" | "retryAction">>
	): void {
		const task = this.tasks.get(id);
		if (!task) return;
		this.tasks.set(id, { ...task, ...changes });
		this.notify();
	}

	fail(id: string, error: string, errorDetails?: string, retryAction?: () => void): void {
		const task = this.tasks.get(id);
		if (!task) return;
		this.tasks.set(id, {
			...task,
			status: error,
			error,
			errorDetails,
			canCancel: false,
			progress: undefined,
			canRetry: Boolean(retryAction),
			retryAction,
			completedAt: Date.now(),
		});
		this.notify();
	}

	/** Removes the failed attempt before starting its replacement, making retry one-shot even under repeated clicks. */
	retry(id: string): boolean {
		const task = this.tasks.get(id);
		if (!task?.error || !task.canRetry || !task.retryAction) return false;

		const retryAction = task.retryAction;
		this.tasks.delete(id);
		this.notify();
		retryAction();
		return true;
	}

	finish(id: string): void {
		if (!this.tasks.delete(id)) return;
		this.notify();
	}

	dismiss(id: string): void {
		if (!this.tasks.delete(id)) return;
		this.notify();
	}

	clearFailed(): void {
		let changed = false;
		for (const [id, task] of this.tasks.entries()) {
			if (task.error) {
				this.tasks.delete(id);
				changed = true;
			}
		}
		if (changed) this.notify();
	}

	hasTask(id: string): boolean {
		return this.tasks.has(id);
	}

	subscribe(listener: TaskTrackerListener): () => void {
		this.listeners.add(listener);
		try {
			listener(this.getTasks());
		} catch (error) {
			console.error("ai-transcribe-summary: task tracker listener failed", error);
		}
		return () => this.listeners.delete(listener);
	}

	private notify(): void {
		const tasks = this.getTasks();
		for (const listener of this.listeners) {
			try {
				listener(tasks);
			} catch (error) {
				console.error("ai-transcribe-summary: task tracker listener failed", error);
			}
		}
	}
}
