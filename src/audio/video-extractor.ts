import { execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";
import { encodeWav } from "./chunker";
import { t } from "../i18n";
import { logDebug } from "../log";

const execFileAsync = promisify(execFile);

export interface VideoAudioExtractionRequest {
	blob: Blob;
	filePath?: string;
	mimeType: string;
	baseName?: string;
	extension?: string;
	ffmpegPath?: string;
	signal?: AbortSignal;
	onProgress?: (progress: { status: string }) => void;
}

const DEFAULT_MAC_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
const DEFAULT_LINUX_DIRS = ["/usr/bin", "/usr/local/bin", "/snap/bin"];

export function getEnhancedEnv(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	if (process.platform === "darwin") {
		const current = env.PATH ? env.PATH.split(":") : [];
		const merged = Array.from(new Set([...DEFAULT_MAC_DIRS, ...current]));
		env.PATH = merged.filter(Boolean).join(":");
	} else if (process.platform === "linux") {
		const current = env.PATH ? env.PATH.split(":") : [];
		const merged = Array.from(new Set([...DEFAULT_LINUX_DIRS, ...current]));
		env.PATH = merged.filter(Boolean).join(":");
	}
	return env;
}

function getCandidatePaths(): string[] {
	if (process.platform === "darwin") {
		return ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"];
	}
	if (process.platform === "win32") {
		const localAppData = process.env.LOCALAPPDATA ?? "";
		return [
			"C:\\ffmpeg\\bin\\ffmpeg.exe",
			"C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe",
			path.join(localAppData, "Microsoft\\WinGet\\Links\\ffmpeg.exe"),
		].filter(Boolean);
	}
	return ["/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/snap/bin/ffmpeg"];
}

let cachedFfmpegBinary: string | null = null;

export function resetFfmpegBinaryCache(): void {
	cachedFfmpegBinary = null;
}

export async function findFfmpegBinary(customPath?: string): Promise<string | undefined> {
	if (customPath && customPath.trim()) {
		const trimmed = customPath.trim();
		const isNamedCommand = !trimmed.includes("/") && !trimmed.includes("\\");
		if (isNamedCommand) {
			try {
				const env = getEnhancedEnv();
				await execFileAsync(trimmed, ["-version"], { env, timeout: 3000 });
				return trimmed;
			} catch {
				logDebug("findFfmpegBinary: configured command not found in PATH", trimmed);
				return undefined;
			}
		}

		try {
			await fs.promises.access(trimmed, fs.constants.X_OK);
			return trimmed;
		} catch {
			logDebug("findFfmpegBinary: configured path not executable", trimmed);
			return undefined;
		}
	}

	if (cachedFfmpegBinary) {
		try {
			if (cachedFfmpegBinary === "ffmpeg") return "ffmpeg";
			await fs.promises.access(cachedFfmpegBinary, fs.constants.X_OK);
			return cachedFfmpegBinary;
		} catch {
			cachedFfmpegBinary = null;
		}
	}

	for (const candidate of getCandidatePaths()) {
		try {
			await fs.promises.access(candidate, fs.constants.X_OK);
			cachedFfmpegBinary = candidate;
			return candidate;
		} catch {
			// Continue probing
		}
	}

	try {
		const env = getEnhancedEnv();
		await execFileAsync("ffmpeg", ["-version"], { env, timeout: 3000 });
		cachedFfmpegBinary = "ffmpeg";
		return "ffmpeg";
	} catch {
		// Not in PATH
	}

	return undefined;
}

export async function extractAudioWithFfmpeg(
	input: { filePath?: string; blob?: Blob },
	ffmpegBinary: string,
	signal?: AbortSignal
): Promise<Blob> {
	let tempInputPath: string | undefined;
	const tempOutputPath = path.join(os.tmpdir(), `ai-extract-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`);

	try {
		let inputPath = input.filePath;
		if (!inputPath || !fs.existsSync(inputPath)) {
			if (!input.blob || input.blob.size === 0) {
				throw new Error("No input file or data available for extraction.");
			}
			tempInputPath = path.join(os.tmpdir(), `ai-input-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
			const buffer = Buffer.from(await input.blob.arrayBuffer());
			await fs.promises.writeFile(tempInputPath, buffer);
			inputPath = tempInputPath;
		}

		const args = [
			"-y",
			"-i", inputPath,
			"-vn",
			"-acodec", "pcm_s16le",
			"-ar", "16000",
			"-ac", "1",
			tempOutputPath,
		];

		const env = getEnhancedEnv();
		await execFileAsync(ffmpegBinary, args, { env, signal, maxBuffer: 10 * 1024 * 1024 });

		const wavBuffer = await fs.promises.readFile(tempOutputPath);
		return new Blob([wavBuffer], { type: "audio/wav" });
	} catch (error: unknown) {
		const stderr = (error as { stderr?: string })?.stderr ?? "";
		if (stderr.includes("Output file does not contain any stream") || stderr.includes("matches no streams") || stderr.includes("does not contain any audio stream")) {
			throw new Error(t("The media file does not contain a usable audio track."));
		}
		throw error;
	} finally {
		if (tempInputPath) {
			await fs.promises.unlink(tempInputPath).catch(() => {});
		}
		await fs.promises.unlink(tempOutputPath).catch(() => {});
	}
}

export async function extractAudioFromVideo(request: VideoAudioExtractionRequest): Promise<Blob> {
	request.onProgress?.({ status: t("Extracting audio from video") });

	const ffmpegBinary = await findFfmpegBinary(request.ffmpegPath);
	if (ffmpegBinary) {
		try {
			logDebug("extractAudioFromVideo: using ffmpeg at", ffmpegBinary);
			return await extractAudioWithFfmpeg(
				{ filePath: request.filePath, blob: request.blob },
				ffmpegBinary,
				request.signal
			);
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			if (message === t("The media file does not contain a usable audio track.")) {
				throw error;
			}
			logDebug("extractAudioFromVideo: ffmpeg failed, attempting fallback", error);
		}
	}

	// Fallback to Web Audio API
	let bufferData: ArrayBuffer | undefined;
	if (request.blob && request.blob.size > 0) {
		bufferData = await request.blob.arrayBuffer();
	} else if (request.filePath) {
		try {
			const fileBuffer = await fs.promises.readFile(request.filePath);
			if (fileBuffer) {
				bufferData = fileBuffer.buffer.slice(fileBuffer.byteOffset, fileBuffer.byteOffset + fileBuffer.byteLength);
			}
		} catch (readError) {
			logDebug("extractAudioFromVideo: fallback could not read file", readError);
		}
	}

	if (bufferData) {
		const audioContext = new AudioContext();
		try {
			const audioBuffer = await audioContext.decodeAudioData(bufferData);
			if (audioBuffer.numberOfChannels === 0 || audioBuffer.length === 0) {
				throw new Error(t("The media file does not contain a usable audio track."));
			}
			const wavArrayBuffer = encodeWav(audioBuffer);
			return new Blob([wavArrayBuffer], { type: "audio/wav" });
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			if (message === t("The media file does not contain a usable audio track.")) {
				throw error;
			}
			logDebug("extractAudioFromVideo: Web Audio decodeAudioData failed", error);
		} finally {
			await audioContext.close();
		}
	}

	const ext = request.extension ?? (request.filePath ? path.extname(request.filePath).replace(".", "") : "video");
	const name = request.baseName ?? (request.filePath ? path.basename(request.filePath) : "video");
	if (!ffmpegBinary) {
		throw new Error(
			t(
				"Could not extract audio from video \"{name}\". This media format ({extension}) requires FFmpeg. Please install FFmpeg (e.g. 'brew install ffmpeg' on macOS) or configure its path in Settings under Transcription.",
				{ name, extension: ext }
			)
		);
	}
	throw new Error(
		t("Could not extract audio track from video \"{name}\". The file may not contain audio, or its codec is not supported.", { name })
	);
}
