import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	extractAudioFromVideo,
	extractAudioWithFfmpeg,
	findFfmpegBinary,
	getEnhancedEnv,
	resetFfmpegBinaryCache,
} from "../../src/audio/video-extractor";
import { execFile } from "child_process";

const { accessMock, readFileMock, writeFileMock, unlinkMock, existsSyncMock, execFileMock } = vi.hoisted(() => ({
	accessMock: vi.fn(),
	readFileMock: vi.fn(),
	writeFileMock: vi.fn(),
	unlinkMock: vi.fn(),
	existsSyncMock: vi.fn(),
	execFileMock: vi.fn((cmd: string, args: unknown, opts: unknown, cb?: unknown) => {
		const callback = typeof opts === "function" ? opts : cb;
		if (typeof callback === "function") {
			callback(null, { stdout: "ffmpeg version 7.0", stderr: "" });
		}
	}),
}));

vi.mock("obsidian", () => ({
	getLanguage: () => "en",
}));

vi.mock("child_process", () => ({
	execFile: execFileMock,
}));

vi.mock("fs", () => {
	const promises = {
		access: accessMock,
		readFile: readFileMock,
		writeFile: writeFileMock,
		unlink: unlinkMock,
	};
	return {
		default: {
			constants: { X_OK: 1 },
			existsSync: existsSyncMock,
			promises,
		},
		constants: { X_OK: 1 },
		existsSync: existsSyncMock,
		promises,
	};
});

describe("video-extractor environment and binary detection", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		resetFfmpegBinaryCache();
		accessMock.mockReset();
		execFileMock.mockReset();
		execFileMock.mockImplementation((cmd: string, args: unknown, opts: unknown, cb?: unknown) => {
			const callback = typeof opts === "function" ? opts : cb;
			if (typeof callback === "function") {
				callback(null, { stdout: "ffmpeg version 7.0", stderr: "" });
			}
		});
	});

	it("augments PATH with Homebrew and system directories", () => {
		const env = getEnhancedEnv();
		if (process.platform === "darwin") {
			expect(env.PATH).toContain("/opt/homebrew/bin");
			expect(env.PATH).toContain("/usr/local/bin");
		}
	});

	it("uses configured custom ffmpeg path when valid", async () => {
		accessMock.mockResolvedValueOnce(undefined);
		const binary = await findFfmpegBinary("/custom/path/ffmpeg");
		expect(binary).toBe("/custom/path/ffmpeg");
		expect(accessMock).toHaveBeenCalledWith("/custom/path/ffmpeg", expect.any(Number));
	});

	it("returns undefined when custom path is invalid and not found in PATH", async () => {
		accessMock.mockRejectedValue(new Error("ENOENT"));
		execFileMock.mockImplementation((cmd: string, args: unknown, opts: unknown, cb?: unknown) => {
			const callback = typeof opts === "function" ? opts : cb;
			if (typeof callback === "function") {
				callback(new Error("not found"));
			}
		});

		const binary = await findFfmpegBinary("/invalid/custom/path");
		expect(binary).toBeUndefined();
	});

	it("finds standard candidate location when custom path is empty", async () => {
		accessMock.mockResolvedValueOnce(undefined);

		const binary = await findFfmpegBinary();
		expect(binary).toBeDefined();
		expect(binary).not.toBe("ffmpeg");
	});

	it("falls back to PATH lookup when candidates do not exist", async () => {
		accessMock.mockRejectedValue(new Error("ENOENT"));

		const binary = await findFfmpegBinary();
		expect(binary).toBe("ffmpeg");
	});

	it("returns undefined when no binary is found anywhere", async () => {
		accessMock.mockRejectedValue(new Error("ENOENT"));
		execFileMock.mockImplementation((cmd: string, args: unknown, opts: unknown, cb?: unknown) => {
			const callback = typeof opts === "function" ? opts : cb;
			if (typeof callback === "function") {
				callback(new Error("Command failed: ffmpeg"));
			}
		});

		const binary = await findFfmpegBinary();
		expect(binary).toBeUndefined();
	});
});

describe("extractAudioWithFfmpeg", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		existsSyncMock.mockReset();
		readFileMock.mockReset();
		unlinkMock.mockReset();
		execFileMock.mockReset();
	});

	it("calls ffmpeg with 16kHz mono PCM WAV parameters", async () => {
		existsSyncMock.mockReturnValue(true);
		readFileMock.mockResolvedValueOnce(Buffer.from("RIFF....WAVE"));
		unlinkMock.mockResolvedValue(undefined);
		execFileMock.mockImplementation((cmd: string, args: unknown, opts: unknown, cb?: unknown) => {
			const callback = typeof opts === "function" ? opts : cb;
			if (typeof callback === "function") {
				callback(null);
			}
		});

		const blob = await extractAudioWithFfmpeg({ filePath: "/vault/meeting.mkv" }, "/opt/homebrew/bin/ffmpeg");

		expect(execFileMock).toHaveBeenCalledWith(
			"/opt/homebrew/bin/ffmpeg",
			expect.arrayContaining(["-i", "/vault/meeting.mkv", "-vn", "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1"]),
			expect.anything(),
			expect.anything()
		);
		expect(blob.type).toBe("audio/wav");
	});

	it("detects when video file has no audio stream", async () => {
		existsSyncMock.mockReturnValue(true);
		unlinkMock.mockResolvedValue(undefined);
		execFileMock.mockImplementation((cmd: string, args: unknown, opts: unknown, cb?: unknown) => {
			const callback = typeof opts === "function" ? opts : cb;
			if (typeof callback === "function") {
				const err = Object.assign(new Error("Output file does not contain any stream"), {
					stderr: "Output file does not contain any stream",
				});
				callback(err);
			}
		});

		await expect(
			extractAudioWithFfmpeg({ filePath: "/vault/silent.mp4" }, "/opt/homebrew/bin/ffmpeg")
		).rejects.toThrow("The media file does not contain a usable audio track.");
	});
});

describe("extractAudioFromVideo", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		resetFfmpegBinaryCache();
		accessMock.mockReset();
		execFileMock.mockReset();
	});

	it("throws clear installation instructions when ffmpeg is not found and decodeAudioData fails", async () => {
		accessMock.mockRejectedValue(new Error("ENOENT"));
		execFileMock.mockImplementation((cmd: string, args: unknown, opts: unknown, cb?: unknown) => {
			const callback = typeof opts === "function" ? opts : cb;
			if (typeof callback === "function") {
				callback(new Error("not found"));
			}
		});

		const onProgress = vi.fn();
		await expect(
			extractAudioFromVideo({
				blob: new Blob([]),
				filePath: "/vault/test.mkv",
				mimeType: "video/x-matroska",
				extension: "mkv",
				baseName: "test",
				onProgress,
			})
		).rejects.toThrow(/requires FFmpeg/);

		expect(onProgress).toHaveBeenCalledWith({ status: "Extracting audio from video" });
	});
});
