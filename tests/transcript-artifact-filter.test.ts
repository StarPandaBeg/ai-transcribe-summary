import { describe, expect, it } from "vitest";
import { filterTranscriptArtifacts } from "../src/transcript-artifact-filter";

describe("filterTranscriptArtifacts", () => {
	it("removes matching text and timestamped segments", () => {
		const result = filterTranscriptArtifacts(
			"We approved the plan. Thanks for watching. Next meeting is Friday.",
			[
				{ start: 0, end: 2, text: "We approved the plan." },
				{ start: 2, end: 4, text: "Thanks for watching." },
				{ start: 4, end: 6, text: "Next meeting is Friday." },
			],
			"Thanks for watching."
		);

		expect(result).toEqual({
			text: "We approved the plan. Next meeting is Friday.",
			segments: [
				{ start: 0, end: 2, text: "We approved the plan." },
				{ start: 4, end: 6, text: "Next meeting is Friday." },
			],
			removedCount: 1,
		});
	});

	it("matches case-insensitively and ignores repeated whitespace", () => {
		const result = filterTranscriptArtifacts(
			"СПАСИБО ЗА ПРОСМОТР.",
			[{ text: "  СПАСИБО   ЗА ПРОСМОТР. " }],
			"спасибо за просмотр."
		);
		expect(result).toEqual({ text: "", segments: [], removedCount: 1 });
	});

	it("does not remove a phrase embedded in a longer legitimate segment", () => {
		const transcript = "Спасибо за просмотр отчёта и подробные замечания.";
		const segments = [{ text: transcript }];
		expect(filterTranscriptArtifacts(transcript, segments, "Спасибо за просмотр")).toEqual({
			text: transcript,
			segments,
			removedCount: 0,
		});
	});

	it("filters exact lines when segment data is unavailable", () => {
		expect(filterTranscriptArtifacts("Useful text\nArtifact\nMore text", [], "Artifact")).toEqual({
			text: "Useful text\nMore text",
			segments: [],
			removedCount: 1,
		});
	});

	it("leaves provider output untouched when no phrases are configured", () => {
		const transcript = "  Original formatting\n";
		const segments = [{ text: "Original formatting" }];
		expect(filterTranscriptArtifacts(transcript, segments, "")).toEqual({ text: transcript, segments, removedCount: 0 });
	});
});
