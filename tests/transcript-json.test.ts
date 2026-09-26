import { describe, expect, it } from "vitest";
import { readTranscriptJson } from "../src/transcript-json";

describe("readTranscriptJson", () => {
	it("joins structured transcript segments for summarization", () => {
		const content = JSON.stringify({
			segments: [
				{ start: 0, end: 2, text: "First point." },
				{ start: 2, end: 4, text: "Second point." },
			],
		});
		expect(readTranscriptJson(content)).toBe("First point. Second point.");
	});

	it("applies configured artifact filtering", () => {
		const content = JSON.stringify({ segments: [{ text: "Useful." }, { text: "Thanks for watching." }] });
		expect(readTranscriptJson(content, "Thanks for watching.")).toBe("Useful.");
	});

	it("rejects unrelated or malformed JSON", () => {
		expect(() => readTranscriptJson("not json")).toThrow("not a valid transcript");
		expect(() => readTranscriptJson(JSON.stringify({ text: "No segments" }))).toThrow("not a valid transcript");
		expect(() => readTranscriptJson(JSON.stringify({ segments: [{ start: 0 }] }))).toThrow("not a valid transcript");
	});
});
