import { App, normalizePath } from "obsidian";
import { logDebug } from "../log";
import type { TranscriptionSegment } from "../providers/transcription";

export interface TranscribedPiece {
	text: string;
	segments: TranscriptionSegment[];
}

export interface ChunkCache {
	get(cacheKey: string, chunkIndex: number): Promise<TranscribedPiece | undefined>;
	set(cacheKey: string, chunkIndex: number, piece: TranscribedPiece): Promise<void>;
	clear(cacheKey: string): Promise<void>;
	getCachedChunkIndices(cacheKey: string): Promise<number[]>;
}

/**
 * Persists transcribed chunk results to disk under the plugin's cache folder, so a failed or
 * interrupted transcription job can be retried without re-uploading and re-paying for chunks
 * that already completed successfully.
 */
export class VaultChunkCache implements ChunkCache {
	private memoryCache = new Map<string, Map<number, TranscribedPiece>>();
	private loadedKeys = new Set<string>();
	private writeChains = new Map<string, Promise<void>>();

	constructor(private app: App) {}

	private getCacheDir(): string {
		const configDir = this.app.vault?.configDir ?? ".obsidian";
		return normalizePath(`${configDir}/plugins/ai-transcribe-summary/cache`);
	}

	private getFilePath(cacheKey: string): string {
		return normalizePath(`${this.getCacheDir()}/${cacheKey}.json`);
	}

	private async ensureLoaded(cacheKey: string): Promise<void> {
		if (this.loadedKeys.has(cacheKey)) return;
		this.loadedKeys.add(cacheKey);

		const adapter = this.app.vault?.adapter;
		if (!adapter) return;

		const filePath = this.getFilePath(cacheKey);
		try {
			if (await adapter.exists(filePath)) {
				const content = await adapter.read(filePath);
				const parsed = JSON.parse(content) as Record<string, TranscribedPiece>;
				const map = new Map<number, TranscribedPiece>();
				for (const [idxStr, piece] of Object.entries(parsed)) {
					const idx = Number(idxStr);
					if (!Number.isNaN(idx) && piece && typeof piece.text === "string" && Array.isArray(piece.segments)) {
						map.set(idx, piece);
					}
				}
				this.memoryCache.set(cacheKey, map);
				logDebug(`chunk cache loaded for "${cacheKey}" with ${map.size} chunk(s)`);
			}
		} catch (error) {
			logDebug(`failed to read chunk cache file "${filePath}"`, error);
		}
	}

	async get(cacheKey: string, chunkIndex: number): Promise<TranscribedPiece | undefined> {
		await this.ensureLoaded(cacheKey);
		return this.memoryCache.get(cacheKey)?.get(chunkIndex);
	}

	async getCachedChunkIndices(cacheKey: string): Promise<number[]> {
		await this.ensureLoaded(cacheKey);
		const map = this.memoryCache.get(cacheKey);
		return map ? [...map.keys()].sort((a, b) => a - b) : [];
	}

	async set(cacheKey: string, chunkIndex: number, piece: TranscribedPiece): Promise<void> {
		await this.ensureLoaded(cacheKey);
		let map = this.memoryCache.get(cacheKey);
		if (!map) {
			map = new Map();
			this.memoryCache.set(cacheKey, map);
		}
		map.set(chunkIndex, piece);

		const previousChain = this.writeChains.get(cacheKey) ?? Promise.resolve();
		const nextChain = previousChain
			.catch(() => {})
			.then(async () => {
				const adapter = this.app.vault?.adapter;
				if (!adapter) return;

				const currentMap = this.memoryCache.get(cacheKey);
				if (!currentMap) return;

				const obj: Record<string, TranscribedPiece> = {};
				for (const [idx, item] of currentMap.entries()) {
					obj[idx.toString()] = item;
				}

				try {
					const dir = this.getCacheDir();
					if (!(await adapter.exists(dir))) {
						await adapter.mkdir(dir);
					}
					const filePath = this.getFilePath(cacheKey);
					await adapter.write(filePath, JSON.stringify(obj, null, 2));
				} catch (error) {
					logDebug(`failed to write chunk cache file for "${cacheKey}"`, error);
				}
			});
		this.writeChains.set(cacheKey, nextChain);
		await nextChain;
	}

	async clear(cacheKey: string): Promise<void> {
		this.memoryCache.delete(cacheKey);
		this.loadedKeys.delete(cacheKey);

		const adapter = this.app.vault?.adapter;
		if (!adapter) return;

		const filePath = this.getFilePath(cacheKey);
		try {
			if (await adapter.exists(filePath)) {
				await adapter.remove(filePath);
				logDebug(`chunk cache file cleared for "${cacheKey}"`);
			}
		} catch (error) {
			logDebug(`failed to clear chunk cache file "${filePath}"`, error);
		}
	}
}
