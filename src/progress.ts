export interface ProgressUpdate {
	status: string;
	completed?: number;
	total?: number;
	unit?: "chunks" | "steps";
}

export type ProgressCallback = (update: ProgressUpdate) => void;
