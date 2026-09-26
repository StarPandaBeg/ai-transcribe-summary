import { t } from "./i18n";
import { filterTranscriptArtifacts } from "./transcript-artifact-filter";

interface JsonTranscriptSegment {
	text: string;
}

/** Accepts the plugin's structured transcript format at the file boundary and returns summary-ready text. */
export function readTranscriptJson(content: string, excludedPhrases = ""): string {
	let value: unknown;
	try {
		value = JSON.parse(content);
	} catch {
		throw new Error(t("This JSON file is not a valid transcript. Expected a segments array with text in each segment."));
	}

	if (!value || typeof value !== "object" || !("segments" in value) || !Array.isArray(value.segments)) {
		throw new Error(t("This JSON file is not a valid transcript. Expected a segments array with text in each segment."));
	}

	const segments: JsonTranscriptSegment[] = [];
	for (const segment of value.segments) {
		if (!segment || typeof segment !== "object" || !("text" in segment) || typeof segment.text !== "string") {
			throw new Error(t("This JSON file is not a valid transcript. Expected a segments array with text in each segment."));
		}
		segments.push({ text: segment.text });
	}

	const text = segments.map((segment) => segment.text.trim()).filter(Boolean).join(" ");
	return filterTranscriptArtifacts(text, segments, excludedPhrases).text;
}
