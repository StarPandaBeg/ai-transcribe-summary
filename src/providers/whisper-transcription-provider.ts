import { RequestUrlParam, RequestUrlResponse } from "obsidian";
import { chunkAtSilence, needsChunking } from "../audio/chunker";
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
const RETRY_BASE_DELAY_MS = 1000;
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
			throw new Error(`${PROVIDER_LABELS[this.id]} API key is not set. Add it in Settings under "${PROVIDER_LABELS[this.id]}".`);
		}

		const onProgress = request.onProgress ?? (() => {});
		const signal = request.signal;

		const decodeBeforeUpload = request.extractAudio === true;
		const chunked = decodeBeforeUpload || needsChunking(request.audio);
		logDebug("transcribe: audio size", request.audio.size, "bytes, chunking:", chunked, "extracting audio:", decodeBeforeUpload, "model:", this.config.apiModel);

		const options = { vocabularyHints: request.vocabularyHints, language: request.language };

		let pieces: TranscribedPiece[];
		if (chunked) {
			if (decodeBeforeUpload) onProgress({ status: "Extracting audio from video" });
			// chunkAtSilence yields pieces one at a time rather than building the full array up
			// front, so at most MAX_CONCURRENT_CHUNK_UPLOADS encoded WAV chunks are resident in
			// memory alongside the decoded PCM buffer, not every chunk in the recording at once.
			pieces = await this.transcribeChunksConcurrently(chunkAtSilence(request.audio), options, onProgress, signal);
		} else {
			const piece = { data: await request.audio.arrayBuffer(), mimeType: request.audio.type || request.mimeType, startSeconds: 0, chunkIndex: 0, chunkCount: 1 };
			pieces = [await this.transcribeOnePiece(piece, options, 0, signal)];
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
		signal: AbortSignal | undefined
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
					onProgress({ status: `Transcribing 0 of ${totalChunks} chunks`, completed: 0, total: totalChunks, unit: "chunks" });
				}

				results[piece.chunkIndex] = await this.transcribeOnePiece(piece, options, piece.chunkIndex, signal);
				completedCount++;
				onProgress({
					status: `Transcribed ${completedCount} of ${piece.chunkCount} chunks`,
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
		const response = await this.requestWithRetry(
			{
				url,
				method: "POST",
				contentType,
				body,
				headers: { Authorization: `Bearer ${this.config.apiKey}` },
				throw: false,
			},
			signal
		);
		logDebug(`transcribe: chunk ${index + 1} responded`, { status: response.status, durationMs: Date.now() - startedAt, model: this.config.apiModel });

		const json = response.json as WhisperResponseBody | undefined;

		if (response.status >= 400) {
			const detail = json?.error?.message ?? response.text;
			if (response.status === 413) {
				throw new Error(
					`Transcription failed on chunk ${index + 1} (HTTP 413: payload too large). ` +
						`The "${this.config.apiModel}" model has a smaller upload limit than the ~22MB chunk size this plugin targets. ` +
						`Try a different transcription model (e.g. "whisper-1") or lower your recording bitrate in Settings.`
				);
			}
			throw new Error(`Transcription failed on chunk ${index + 1} (HTTP ${response.status}): ${detail}`);
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

	/** Retries on thrown errors (network failures) and on HTTP 429/5xx responses (rate limits, transient server errors) - anything else, including a user-initiated abort, is returned/thrown as-is for the caller to handle. */
	private async requestWithRetry(params: RequestUrlParam, signal: AbortSignal | undefined): Promise<RequestUrlResponse> {
		let lastError: unknown;
		for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
			try {
				const response = await requestUrlWithTimeout(params, CHUNK_REQUEST_TIMEOUT_MS, signal);
				if ((response.status === 429 || response.status >= 500) && attempt < MAX_RETRIES - 1) {
					logDebug(`transcribe: request returned HTTP ${response.status} (attempt ${attempt + 1}/${MAX_RETRIES}), retrying`);
					await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
					continue;
				}
				return response;
			} catch (error) {
				if (error instanceof RequestAbortedError) throw error;
				lastError = error;
				if (attempt < MAX_RETRIES - 1) {
					logDebug(`transcribe: request failed (attempt ${attempt + 1}/${MAX_RETRIES}), retrying`, error);
					await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
				}
			}
		}
		throw lastError;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, ms));
}
