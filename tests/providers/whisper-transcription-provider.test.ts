import { beforeEach, describe, expect, it, vi } from "vitest";
import { setRetryBaseDelayMsForTest, WhisperTranscriptionProvider } from "../../src/providers/whisper-transcription-provider";

const { chunkAtSilenceMock, needsChunkingMock, requestUrlMock, extractAudioFromVideoMock } = vi.hoisted(() => ({
	chunkAtSilenceMock: vi.fn(),
	needsChunkingMock: vi.fn(() => true),
	requestUrlMock: vi.fn(),
	extractAudioFromVideoMock: vi.fn(async ({ blob, onProgress }) => {
		onProgress?.({ status: "Extracting audio from video" });
		return blob;
	}),
}));

vi.mock("obsidian", () => ({
	getLanguage: () => "en",
	requestUrl: requestUrlMock,
	Notice: class {
		constructor(_message: string, _duration?: number) {}
	},
}));

vi.mock("../../src/audio/video-extractor", () => ({
	extractAudioFromVideo: extractAudioFromVideoMock,
}));

vi.mock("../../src/audio/chunker", () => ({
	needsChunking: needsChunkingMock,
	chunkAtSilence: async function* (blob: Blob, targetChunkBytes?: number) {
		chunkAtSilenceMock(blob, targetChunkBytes);
		const chunkCount = (blob as unknown as { chunkCount: number }).chunkCount;
		for (let i = 0; i < chunkCount; i++) {
			yield {
				data: new ArrayBuffer(1),
				mimeType: "audio/wav",
				startSeconds: i * 10,
				endSeconds: (i + 1) * 10,
				chunkIndex: i,
				chunkCount,
			};
		}
	},
}));

function fakeChunkedBlob(chunkCount: number): Blob {
	return { chunkCount } as unknown as Blob;
}

/** A controllable promise whose resolution the test drives explicitly, to observe in-flight concurrency. */
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => (resolve = res));
	return { promise, resolve };
}

beforeEach(() => {
	requestUrlMock.mockReset();
	chunkAtSilenceMock.mockClear();
	needsChunkingMock.mockReset();
	needsChunkingMock.mockReturnValue(true);
	extractAudioFromVideoMock.mockClear();
	setRetryBaseDelayMsForTest(0);
});

describe("WhisperTranscriptionProvider concurrent chunk uploads", () => {
	it("extracts video audio even when the source file is below the normal chunk threshold", async () => {
		needsChunkingMock.mockReturnValue(false);
		requestUrlMock.mockResolvedValue({ status: 200, json: { text: "video text", segments: [{ start: 0.5, end: 2.25, text: " video text " }] } });
		const onProgress = vi.fn();
		const video = fakeChunkedBlob(1);
		const provider = new WhisperTranscriptionProvider("openai", { apiKey: "key", baseUrl: "https://api.openai.com/v1", apiModel: "whisper-1" });

		const result = await provider.transcribe({
			audio: video,
			mimeType: "video/mp4",
			extractAudio: true,
			vocabularyHints: "",
			language: "",
			onProgress,
		});

		expect(result.text).toBe("video text");
		expect(result.segments).toEqual([{ start: 0.5, end: 2.25, text: "video text", speaker: 0 }]);
		expect(chunkAtSilenceMock).toHaveBeenCalledWith(video, 22 * 1024 * 1024);
		expect(onProgress).toHaveBeenCalledWith({ status: "Extracting audio from video" });
		expect(onProgress).toHaveBeenCalledWith({ status: "Transcribing 0 of 1 chunks", completed: 0, total: 1, unit: "chunks" });
		expect(onProgress).toHaveBeenCalledWith({ status: "Transcribed 1 of 1 chunks", completed: 1, total: 1, unit: "chunks" });
	});

	it("returns chunk texts in original order even when they complete out of order", async () => {
		const deferredByIndex = [deferred<void>(), deferred<void>(), deferred<void>()];
		let callIndex = 0;

		requestUrlMock.mockImplementation(async () => {
			const index = callIndex++;
			await deferredByIndex[index].promise;
			return { status: 200, json: { text: `text-${index}`, segments: [{ start: 1, end: 2, text: ` text-${index} ` }] } };
		});

		const provider = new WhisperTranscriptionProvider("openai", { apiKey: "key", baseUrl: "https://api.openai.com/v1", apiModel: "whisper-1" });
		const resultPromise = provider.transcribe({ audio: fakeChunkedBlob(3), mimeType: "audio/webm", vocabularyHints: "", language: "" });

		// Resolve out of order: chunk 2 first, then 0, then 1.
		deferredByIndex[2].resolve();
		await Promise.resolve();
		deferredByIndex[0].resolve();
		await Promise.resolve();
		deferredByIndex[1].resolve();

		const result = await resultPromise;
		expect(result.text).toBe("text-0 text-1 text-2");
		expect(result.segments).toEqual([
			{ start: 1, end: 2, text: "text-0", speaker: 0 },
			{ start: 11, end: 12, text: "text-1", speaker: 0 },
			{ start: 21, end: 22, text: "text-2", speaker: 0 },
		]);
	});

	it("requests verbose JSON and falls back to one timed segment when a compatible provider omits segments", async () => {
		needsChunkingMock.mockReturnValue(false);
		requestUrlMock.mockResolvedValue({ status: 200, json: { text: "fallback text", duration: 4.2 } });
		const provider = new WhisperTranscriptionProvider("openai", { apiKey: "key", baseUrl: "https://api.openai.com/v1", apiModel: "whisper-1" });

		const result = await provider.transcribe({ audio: new Blob(["audio"], { type: "audio/webm" }), mimeType: "audio/webm", vocabularyHints: "", language: "" });

		expect(result.segments).toEqual([{ start: 0, end: 4.2, text: "fallback text", speaker: 0 }]);
		const request = requestUrlMock.mock.calls[0][0] as { body: ArrayBuffer };
		expect(new TextDecoder().decode(request.body)).toContain('name="response_format"\r\n\r\nverbose_json');
	});

	it("never has more than MAX_CONCURRENT_CHUNK_UPLOADS (3) requests in flight at once", async () => {
		const totalChunks = 7;
		let inFlight = 0;
		let maxInFlight = 0;
		const releases: (() => void)[] = [];

		requestUrlMock.mockImplementation(async () => {
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await new Promise<void>((resolve) => releases.push(resolve));
			inFlight--;
			return { status: 200, json: { text: "chunk" } };
		});

		const provider = new WhisperTranscriptionProvider("openai", { apiKey: "key", baseUrl: "https://api.openai.com/v1", apiModel: "whisper-1" });
		const resultPromise = provider.transcribe({ audio: fakeChunkedBlob(totalChunks), mimeType: "audio/webm", vocabularyHints: "", language: "" });

		// Drain releases as they show up until every chunk has been processed.
		let released = 0;
		while (released < totalChunks) {
			if (releases.length > 0) {
				releases.shift()!();
				released++;
			}
			await Promise.resolve();
		}

		await resultPromise;
		expect(maxInFlight).toBeLessThanOrEqual(3);
		expect(maxInFlight).toBeGreaterThan(1); // sanity check that it actually ran concurrently, not sequentially
	});

	it("uses custom maxFileSizeMb for chunk threshold and silence splitting", async () => {
		needsChunkingMock.mockReturnValue(true);
		requestUrlMock.mockResolvedValue({ status: 200, json: { text: "text" } });
		const provider = new WhisperTranscriptionProvider("openai", {
			apiKey: "key",
			baseUrl: "https://api.openai.com/v1",
			apiModel: "whisper-1",
			maxFileSizeMb: 15,
		});

		const audio = fakeChunkedBlob(1);
		await provider.transcribe({ audio, mimeType: "audio/webm", vocabularyHints: "", language: "" });

		expect(needsChunkingMock).toHaveBeenCalledWith(audio, 15 * 1024 * 1024);
		expect(chunkAtSilenceMock).toHaveBeenCalledWith(audio, 15 * 1024 * 1024);
	});

	it("reports the configured max file size in HTTP 413 error", async () => {
		needsChunkingMock.mockReturnValue(false);
		requestUrlMock.mockResolvedValue({ status: 413, text: "Payload Too Large" });
		const provider = new WhisperTranscriptionProvider("openai", {
			apiKey: "key",
			baseUrl: "https://api.openai.com/v1",
			apiModel: "whisper-1",
			maxFileSizeMb: 18,
		});

		await expect(
			provider.transcribe({ audio: new Blob(["x"]), mimeType: "audio/webm", vocabularyHints: "", language: "" })
		).rejects.toThrow('smaller upload limit than the 18MB chunk size configured');
	});

	it("retries a failed chunk up to 3 times and succeeds if a retry succeeds", async () => {
		needsChunkingMock.mockReturnValue(true);
		let callCount = 0;
		requestUrlMock.mockImplementation(async () => {
			callCount++;
			if (callCount === 1) {
				return { status: 500, text: "Internal Server Error" };
			}
			return { status: 200, json: { text: "recovered text" } };
		});

		const provider = new WhisperTranscriptionProvider("openai", { apiKey: "key", baseUrl: "https://api.openai.com/v1", apiModel: "whisper-1" });
		const result = await provider.transcribe({ audio: fakeChunkedBlob(1), mimeType: "audio/webm", vocabularyHints: "", language: "" });

		expect(result.text).toBe("recovered text");
		expect(callCount).toBe(2);
	});

	it("fails after exhausting 3 chunk retries", async () => {
		needsChunkingMock.mockReturnValue(true);
		let callCount = 0;
		requestUrlMock.mockImplementation(async () => {
			callCount++;
			return { status: 502, text: "Bad Gateway" };
		});

		const provider = new WhisperTranscriptionProvider("openai", { apiKey: "key", baseUrl: "https://api.openai.com/v1", apiModel: "whisper-1" });
		await expect(
			provider.transcribe({ audio: fakeChunkedBlob(1), mimeType: "audio/webm", vocabularyHints: "", language: "" })
		).rejects.toThrow("Transcription failed on chunk 1 (HTTP 502)");

		expect(callCount).toBe(3);
	});

	it("reuses cached chunks and only transcribes uncached ones", async () => {
		needsChunkingMock.mockReturnValue(true);
		const cachedPiece = { text: "from cache", segments: [{ start: 0, end: 10, text: "from cache", speaker: 0 as const }] };
		const chunkCache = {
			get: vi.fn(async (_key: string, idx: number) => (idx === 0 ? cachedPiece : undefined)),
			set: vi.fn(async () => {}),
			clear: vi.fn(async () => {}),
			getCachedChunkIndices: vi.fn(async () => [0]),
		};

		requestUrlMock.mockResolvedValue({ status: 200, json: { text: "from api" } });

		const provider = new WhisperTranscriptionProvider("openai", { apiKey: "key", baseUrl: "https://api.openai.com/v1", apiModel: "whisper-1" });
		const result = await provider.transcribe({
			audio: fakeChunkedBlob(2),
			mimeType: "audio/webm",
			vocabularyHints: "",
			language: "",
			cacheKey: "test-cache-key",
			chunkCache,
		});

		// Only chunk 1 should have been requested via network
		expect(requestUrlMock).toHaveBeenCalledTimes(1);
		expect(chunkCache.get).toHaveBeenCalledWith("test-cache-key", 0);
		expect(chunkCache.get).toHaveBeenCalledWith("test-cache-key", 1);
		expect(chunkCache.set).toHaveBeenCalledWith("test-cache-key", 1, expect.objectContaining({ text: "from api" }));
		expect(result.text).toBe("from cache from api");
	});
});
