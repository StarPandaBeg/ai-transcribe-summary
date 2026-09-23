import { describe, expect, it } from "vitest";
import { DEFAULT_SUMMARY_PROMPT_ID, normalizeSummaryPrompts, resolveSummaryPrompt } from "../src/summary-prompts";

const defaultPrompt = "Current localized default";
const knownDefaults = ["Old English default", "Old Russian default"];

describe("summary prompts", () => {
	it("migrates a customized legacy prompt into the default named prompt", () => {
		expect(normalizeSummaryPrompts(undefined, "My custom instructions", defaultPrompt, "Default", knownDefaults)).toEqual([
			{ id: DEFAULT_SUMMARY_PROMPT_ID, name: "Default", prompt: "My custom instructions" },
		]);
	});

	it("refreshes a legacy built-in prompt to the current localized default", () => {
		expect(normalizeSummaryPrompts(undefined, "Old Russian default", defaultPrompt, "Default", knownDefaults)[0].prompt).toBe(defaultPrompt);
	});

	it("keeps an arbitrary persisted prompt collection and repairs duplicate ids", () => {
		const prompts = normalizeSummaryPrompts(
			[
				{ id: "custom", name: "Decisions", prompt: "List decisions" },
				{ id: "custom", name: "Tasks", prompt: "List tasks" },
			],
			undefined,
			defaultPrompt,
			"Default",
			knownDefaults
		);

		expect(prompts).toEqual([
			{ id: "custom", name: "Decisions", prompt: "List decisions" },
			{ id: "custom-2", name: "Tasks", prompt: "List tasks" },
		]);
		expect(resolveSummaryPrompt(prompts, "custom-2").prompt).toBe("List tasks");
	});

	it("falls back to the first prompt when the selected id no longer exists", () => {
		const prompts = [{ id: "first", name: "First", prompt: "First prompt" }];
		expect(resolveSummaryPrompt(prompts, "deleted")).toBe(prompts[0]);
	});

	it("recovers from malformed persisted prompt data", () => {
		expect(normalizeSummaryPrompts([{ id: 5, prompt: 7 }], undefined, defaultPrompt, "Default", knownDefaults)).toEqual([
			{ id: DEFAULT_SUMMARY_PROMPT_ID, name: "Default", prompt: defaultPrompt },
		]);
	});
});
