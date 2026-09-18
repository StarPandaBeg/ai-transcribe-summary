import type { TranscriptionProviderId } from "../settings";
import type { ProgressCallback } from "../progress";

export type { TranscriptionProviderId };

export interface TranscriptionRequest {
	/** Recorded audio or the media file selected for transcription. */
	audio: Blob;
	mimeType: string;
	/** Decode the media container and upload extracted WAV audio rather than the original file. */
	extractAudio?: boolean;
	/** Filesystem path to the media file on disk when available, allowing direct streaming extraction. */
	filePath?: string;
	/** Comma-separated names/jargon from settings, passed through where the provider supports it. */
	vocabularyHints: string;
	/** ISO-639-1 code (e.g. "en"), or empty to let the provider auto-detect. */
	language: string;
	/** Called as the provider changes stage or completes a measurable portion of work. */
	onProgress?: ProgressCallback;
	/** When aborted, the provider stops waiting on/starting further requests and rejects with RequestAbortedError. */
	signal?: AbortSignal;
	/** Cache key uniquely identifying this transcription task to reuse already processed chunks upon restart. */
	cacheKey?: string;
	/** Storage for intermediate chunk transcription results. */
	chunkCache?: import("../audio/chunk-cache").ChunkCache;
}

export interface TranscriptionResult {
	text: string;
	segments: TranscriptionSegment[];
	/** True if repetition-loop scanning (PRD Tier 1) flagged abnormally repeated phrases in `text`. */
	repetitionWarning: boolean;
}

export interface TranscriptionSegment {
	start: number;
	end: number;
	text: string;
	speaker: 0;
}

/**
 * One implementation per TranscriptionProviderId (openai, openrouter - both
 * Whisper-compatible). A provider is responsible for its own size-limit
 * handling internally (e.g. Whisper's silence-aware chunking + stitching);
 * callers only see one request in, one stitched result out.
 */
export interface TranscriptionProvider {
	readonly id: TranscriptionProviderId;
	transcribe(request: TranscriptionRequest): Promise<TranscriptionResult>;
}
