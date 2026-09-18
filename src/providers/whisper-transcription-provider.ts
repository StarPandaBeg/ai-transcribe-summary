import { chunkAtSilence, needsChunking } from "../audio/chunker";
import { extractAudioFromVideo } from "../audio/video-extractor";
import { t } from "../i18n";
import { logDebug } from "../log";
import type { ProgressCallback } from "../progress";
import { encodeMultipartFormData } from "./multipart";
import { hasRepetitionLoop } from "./repetition-detector";
import { RequestAbortedError, requestUrlWithTimeout } from "./request-timeout";
import { TranscriptionProvider, TranscriptionProviderId, TranscriptionRequest, TranscriptionResult, TranscriptionSegment } from "./transcription";

export interface WhisperProviderConfig {
	apiKey: string;
	baseUrl: string;
	/** API model name as sent to the API (e.g. "whisper-1", "whisper-large-v3"). */
	apiModel: string;
	maxFileSizeMb?: number;
	ffmpegPath?: string;
}

/** Whisper transcription response shape, narrowed to the fields this provider reads. */
interface WhisperResponseBody {
	error?: { message?: string };
	text?: string;
	duration?: number;
	segments?: Array<{ start?: unknown; end?: unknown; text?: unknown }>;
}

interface TranscribedPiece {
	text: string;
	segments: TranscriptionSegment[];
}

interface TimedAudioPiece {
	data: ArrayBuffer;
	mimeType: string;
	startSeconds: number;
	endSeconds?: number;
	chunkIndex: number;
	chunkCount: number;
}

const MAX_RETRIES = 3;
let retryBaseDelayMs = 1000;

export function setRetryBaseDelayMsForTest(ms: number): void {
	retryBaseDelayMs = ms;
}

/** Chunk uploads should complete well within this; a stalled connection must not hang the pipeline forever. */
const CHUNK_REQUEST_TIMEOUT_MS = 120_000;
/** Chunk uploads in flight at once - bounded rather than unbounded so memory (each chunk's encoded WAV bytes held until its request completes) and provider rate-limit exposure stay modest on meetings with many chunks. */
const MAX_CONCURRENT_CHUNK_UPLOADS = 3;

const PROVIDER_LABELS: Record<TranscriptionProviderId, string> = {
	openai: "OpenAI",
	openrouter: "OpenRouter",
};

/** Whisper identifies the upload format from the filename extension, not the multipart Content-Type - must match the piece's actual encoding (webm/ogg from the recorder, wav from the chunker). */
function extensionForMimeType(mimeType: string): string {
	if (mimeType.includes("wav")) return "wav";
	if (mimeType.includes("ogg")) return "ogg";
	return "webm";
}

/** Whisper-compatible transcription over the OpenAI-shaped upload API - used for both the OpenAI and OpenRouter transcription providers, which differ only in apiKey/baseUrl/apiModel. */
export class WhisperTranscriptionProvider implements TranscriptionProvider {
	constructor(readonly id: TranscriptionProviderId, private config: WhisperProviderConfig) {}

	async transcribe(request: TranscriptionRequest): Promise<TranscriptionResult> {
		if (!this.config.apiKey) {
			throw new Error(t('{provider} API key is not set. Add it in Settings under "{provider}".', { provider: PROVIDER_LABELS[this.id] }));
		}

		const onProgress = request.onProgress ?? (() => {});
		const signal = request.signal;

		const decodeBeforeUpload = request.extractAudio === true;
		const maxChunkBytes = (this.config.maxFileSizeMb ?? 22) * 1024 * 1024;

		let audioBlob = request.audio;
		if (decodeBeforeUpload) {
			audioBlob = await extractAudioFromVideo({
				blob: request.audio,
				filePath: request.filePath,
				mimeType: request.mimeType,
				ffmpegPath: this.config.ffmpegPath,
				signal,
				onProgress,
			});
		}

		const chunked = decodeBeforeUpload || needsChunking(audioBlob, maxChunkBytes);
		logDebug("transcribe: audio size", audioBlob.size, "bytes, chunking:", chunked, "extracting audio:", decodeBeforeUpload, "model:", this.config.apiModel);

		const options = { vocabularyHints: request.vocabularyHints, language: request.language };

		let pieces: TranscribedPiece[];
		if (chunked) {
			// chunkAtSilence yields pieces one at a time rather than building the full array up
			// front, so at most MAX_CONCURRENT_CHUNK_UPLOADS encoded WAV chunks are resident in
			// memory alongside the decoded PCM buffer, not every chunk in the recording at once.
			pieces = await this.transcribeChunksConcurrently(
				chunkAtSilence(audioBlob, maxChunkBytes),
				options,
				onProgress,
				signal,
				request.cacheKey,
				request.chunkCache
			);
		} else {
			const piece = { data: await audioBlob.arrayBuffer(), mimeType: audioBlob.type || request.mimeType, startSeconds: 0, chunkIndex: 0, chunkCount: 1 };
			pieces = [await this.transcribeChunkWithRetry(piece, options, 0, signal)];
		}

		logDebug("transcribe: piece count", pieces.length);

		const text = pieces.map((piece) => piece.text).join(" ").trim();
		const segments = pieces.flatMap((piece) => piece.segments);
		const repetitionWarning = hasRepetitionLoop(text);
		logDebug("transcribe: complete", { textLength: text.length, segmentCount: segments.length, repetitionWarning });
		return { text, segments, repetitionWarning };
	}

	/**
	 * Consumes `pieces` and uploads each one, at most MAX_CONCURRENT_CHUNK_UPLOADS in flight at
	 * a time - a fixed-size worker pool rather than draining the generator into an array first
	 * and firing everything at once, so at most a handful of chunks' encoded bytes are resident
	 * simultaneously regardless of how many chunks the recording has. Results are returned in
	 * original chunk order even though completion order may differ.
	 */
	private async transcribeChunksConcurrently(
		pieces: AsyncIterable<TimedAudioPiece, void, unknown>,
		options: { vocabularyHints: string; language: string },
		onProgress: ProgressCallback,
		signal: AbortSignal | undefined,
		cacheKey: string | undefined,
		chunkCache: import("../audio/chunk-cache").ChunkCache | undefined
	): Promise<TranscribedPiece[]> {
		const iterator = pieces[Symbol.asyncIterator]();
		const results: TranscribedPiece[] = [];
		let completedCount = 0;
		let totalChunks: number | undefined;

		// The first yielded chunk carries the total discovered during decoding. Completion count
		// is shared across workers because uploads finish out of order, while results remain stored
		// by their original index for deterministic transcript ordering.
		const worker = async () => {
			for (;;) {
				if (signal?.aborted) throw new RequestAbortedError();

				const { value: piece, done } = await iterator.next();
				if (done) return;
				if (totalChunks === undefined) {
					totalChunks = piece.chunkCount;
					onProgress({ status: t("Transcribing {completed} of {total} chunks", { completed: 0, total: totalChunks }), completed: 0, total: totalChunks, unit: "chunks" });
				}

				if (chunkCache && cacheKey) {
					const cached = await chunkCache.get(cacheKey, piece.chunkIndex);
					if (cached) {
						logDebug(`transcribe: chunk ${piece.chunkIndex + 1} loaded from cache`);
						results[piece.chunkIndex] = cached;
						completedCount++;
						onProgress({
							status: t("Transcribed {completed} of {total} chunks", { completed: completedCount, total: piece.chunkCount }),
							completed: completedCount,
							total: piece.chunkCount,
							unit: "chunks",
						});
						continue;
					}
				}

				const transcribed = await this.transcribeChunkWithRetry(piece, options, piece.chunkIndex, signal);
				results[piece.chunkIndex] = transcribed;
				if (chunkCache && cacheKey) {
					await chunkCache.set(cacheKey, piece.chunkIndex, transcribed);
				}
				completedCount++;
				onProgress({
					status: t("Transcribed {completed} of {total} chunks", { completed: completedCount, total: piece.chunkCount }),
					completed: completedCount,
					total: piece.chunkCount,
					unit: "chunks",
				});
			}
		};

		const workers = Array.from({ length: MAX_CONCURRENT_CHUNK_UPLOADS }, () => worker());
		await Promise.all(workers);

		return results;
	}

	private async transcribeChunkWithRetry(
		piece: TimedAudioPiece,
		options: { vocabularyHints: string; language: string },
		index: number,
		signal: AbortSignal | undefined
	): Promise<TranscribedPiece> {
		let lastError: unknown;
		for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
			if (signal?.aborted) throw new RequestAbortedError();
			try {
				if (attempt > 0) {
					logDebug(`transcribe: retrying chunk ${index + 1} (attempt ${attempt + 1}/${MAX_RETRIES})`);
				}
				return await this.transcribeOnePiece(piece, options, index, signal);
			} catch (error) {
				if (error instanceof RequestAbortedError) throw error;
				lastError = error;
				const isNonRetryable =
					error instanceof Error &&
					(error.message.includes("413") || error.message.includes("401") || error.message.includes("403"));
				if (isNonRetryable || attempt >= MAX_RETRIES - 1) {
					break;
				}
				const delayMs = retryBaseDelayMs * 2 ** attempt;
				logDebug(`transcribe: chunk ${index + 1} failed (attempt ${attempt + 1}/${MAX_RETRIES}), retrying in ${delayMs}ms`, error);
				await sleep(delayMs);
			}
		}
		throw lastError;
	}

	private async transcribeOnePiece(
		piece: TimedAudioPiece,
		options: { vocabularyHints: string; language: string },
		index: number,
		signal: AbortSignal | undefined
	): Promise<TranscribedPiece> {
		const extension = extensionForMimeType(piece.mimeType);
		const { contentType, body } = encodeMultipartFormData(
			[
				{ name: "model", value: this.config.apiModel },
				{ name: "response_format", value: "verbose_json" },
				...(options.vocabularyHints ? [{ name: "prompt", value: options.vocabularyHints }] : []),
				...(options.language ? [{ name: "language", value: options.language }] : []),
			],
			[{ name: "file", filename: `audio-${index}.${extension}`, mimeType: piece.mimeType, data: piece.data }]
		);

		const url = `${this.config.baseUrl.replace(/\/$/, "")}/audio/transcriptions`;

		logDebug(`transcribe: uploading chunk ${index + 1}`, { bytes: piece.data.byteLength, model: this.config.apiModel });
		const startedAt = Date.now();
		const response = await requestUrlWithTimeout(
			{
				url,
				method: "POST",
				contentType,
				body,
				headers: { Authorization: `Bearer ${this.config.apiKey}` },
				throw: false,
			},
			CHUNK_REQUEST_TIMEOUT_MS,
			signal
		);
		logDebug(`transcribe: chunk ${index + 1} responded`, { status: response.status, durationMs: Date.now() - startedAt, model: this.config.apiModel });

		const json = response.json as WhisperResponseBody | undefined;

		if (response.status >= 400) {
			const detail = json?.error?.message ?? response.text;
			if (response.status === 413) {
				const maxMb = this.config.maxFileSizeMb ?? 22;
				throw new Error(
					t(
						'Transcription failed on chunk {chunk} (HTTP 413: payload too large). The "{model}" model has a smaller upload limit than the {maxMb}MB chunk size configured. Try lowering "Max Whisper file size (MB)" in Settings or using a different model.',
						{
							chunk: index + 1,
							model: this.config.apiModel,
							maxMb,
						}
					)
				);
			}
			throw new Error(t("Transcription failed on chunk {chunk} (HTTP {status}): {detail}", { chunk: index + 1, status: response.status, detail }));
		}

		const responseText = typeof json?.text === "string" ? json.text.trim() : "";
		const segments = this.parseSegments(json, piece, responseText);
		const text = responseText || segments.map((segment) => segment.text).join(" ");
		return { text, segments };
	}

	private parseSegments(json: WhisperResponseBody | undefined, piece: TimedAudioPiece, fallbackText: string): TranscriptionSegment[] {
		const responseSegments = Array.isArray(json?.segments) ? json.segments : [];
		const segments = responseSegments.flatMap((segment): TranscriptionSegment[] => {
			if (typeof segment.start !== "number" || !Number.isFinite(segment.start) || segment.start < 0) return [];
			if (typeof segment.end !== "number" || !Number.isFinite(segment.end) || segment.end < segment.start) return [];
			if (typeof segment.text !== "string" || !segment.text.trim()) return [];
			return [{ start: piece.startSeconds + segment.start, end: piece.startSeconds + segment.end, text: segment.text.trim(), speaker: 0 }];
		});
		if (segments.length > 0 || !fallbackText) return segments;

		const responseDuration = typeof json?.duration === "number" && Number.isFinite(json.duration) && json.duration >= 0 ? json.duration : undefined;
		const end = piece.endSeconds ?? (responseDuration === undefined ? piece.startSeconds : piece.startSeconds + responseDuration);
		return [{ start: piece.startSeconds, end, text: fallbackText, speaker: 0 }];
	}
}

function sleep(ms: number): Promise<void> {
	if (ms <= 0) return Promise.resolve();
	return new Promise((resolve) => window.setTimeout(resolve, ms));
}
