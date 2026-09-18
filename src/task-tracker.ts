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

	update(id: string, changes: Partial<Pick<TrackedTask, "status" | "title" | "canCancel" | "progress">>): void {
		const task = this.tasks.get(id);
		if (!task) return;
		this.tasks.set(id, { ...task, ...changes });
		this.notify();
	}

	finish(id: string): void {
		if (!this.tasks.delete(id)) return;
		this.notify();
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
