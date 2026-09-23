export interface SummaryPrompt {
	id: string;
	name: string;
	prompt: string;
}

export const DEFAULT_SUMMARY_PROMPT_ID = "default";

/** Keeps persisted prompt collections usable after upgrades or manual edits to data.json. */
export function normalizeSummaryPrompts(
	savedPrompts: unknown,
	legacyPrompt: unknown,
	defaultPrompt: string,
	defaultName: string,
	knownDefaultPrompts: readonly string[]
): SummaryPrompt[] {
	if (!Array.isArray(savedPrompts) || savedPrompts.length === 0) {
		const savedLegacyPrompt = typeof legacyPrompt === "string" ? legacyPrompt : "";
		return [
			{
				id: DEFAULT_SUMMARY_PROMPT_ID,
				name: defaultName,
				prompt: !savedLegacyPrompt || knownDefaultPrompts.includes(savedLegacyPrompt) ? defaultPrompt : savedLegacyPrompt,
			},
		];
	}

	const usedIds = new Set<string>();
	const prompts: SummaryPrompt[] = [];
	for (const [index, value] of savedPrompts.entries()) {
		if (!value || typeof value !== "object") continue;
		const candidate = value as Partial<SummaryPrompt>;
		if (typeof candidate.prompt !== "string") continue;

		const baseId = typeof candidate.id === "string" && candidate.id.trim() ? candidate.id.trim() : `prompt-${index + 1}`;
		let id = baseId;
		let suffix = 2;
		while (usedIds.has(id)) id = `${baseId}-${suffix++}`;
		usedIds.add(id);

		prompts.push({
			id,
			name: typeof candidate.name === "string" && candidate.name.trim() ? candidate.name.trim() : `${defaultName} ${index + 1}`,
			prompt: knownDefaultPrompts.includes(candidate.prompt) ? defaultPrompt : candidate.prompt || defaultPrompt,
		});
	}

	return prompts.length > 0
		? prompts
		: [{ id: DEFAULT_SUMMARY_PROMPT_ID, name: defaultName, prompt: defaultPrompt }];
}

export function resolveSummaryPrompt(prompts: readonly SummaryPrompt[], preferredId: string): SummaryPrompt {
	return prompts.find((prompt) => prompt.id === preferredId) ?? prompts[0];
}

export function createSummaryPrompt(name: string, prompt: string): SummaryPrompt {
	return {
		id: `prompt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
		name,
		prompt,
	};
}
