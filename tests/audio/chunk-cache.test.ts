import { describe, expect, it } from "vitest";
import { VaultChunkCache } from "../../src/audio/chunk-cache";
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

describe("VaultChunkCache", () => {
	it("saves and retrieves chunks from memory and disk", async () => {
		const { app, files } = createMockApp();
		const cache = new VaultChunkCache(app);

		const piece0 = { text: "hello", segments: [{ start: 0, end: 1, text: "hello", speaker: 0 as const }] };
		const piece1 = { text: "world", segments: [{ start: 1, end: 2, text: "world", speaker: 0 as const }] };

		await cache.set("task-1", 0, piece0);
		await cache.set("task-1", 1, piece1);

		expect(await cache.get("task-1", 0)).toEqual(piece0);
		expect(await cache.get("task-1", 1)).toEqual(piece1);
		expect(await cache.get("task-1", 2)).toBeUndefined();
		expect(await cache.getCachedChunkIndices("task-1")).toEqual([0, 1]);

		// Verify file was written to disk
		const filePath = ".obsidian/plugins/ai-transcribe-summary/cache/task-1.json";
		expect(files.has(filePath)).toBe(true);

		// A new cache instance loads from disk
		const cache2 = new VaultChunkCache(app);
		expect(await cache2.get("task-1", 0)).toEqual(piece0);
		expect(await cache2.get("task-1", 1)).toEqual(piece1);
		expect(await cache2.getCachedChunkIndices("task-1")).toEqual([0, 1]);
	});

	it("clears cached chunks from memory and deletes file on disk", async () => {
		const { app, files } = createMockApp();
		const cache = new VaultChunkCache(app);

		await cache.set("task-1", 0, { text: "test", segments: [] });
		const filePath = ".obsidian/plugins/ai-transcribe-summary/cache/task-1.json";
		expect(files.has(filePath)).toBe(true);

		await cache.clear("task-1");
		expect(await cache.get("task-1", 0)).toBeUndefined();
		expect(files.has(filePath)).toBe(false);
	});

	it("handles missing adapter gracefully without throwing", async () => {
		const mockAppNoAdapter = { vault: {} } as unknown as App;
		const cache = new VaultChunkCache(mockAppNoAdapter);

		const piece = { text: "fallback", segments: [] };
		await cache.set("key", 0, piece);
		expect(await cache.get("key", 0)).toEqual(piece);
		await cache.clear("key");
		expect(await cache.get("key", 0)).toBeUndefined();
	});
});
