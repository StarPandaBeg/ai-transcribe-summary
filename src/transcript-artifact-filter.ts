interface TranscriptTextSegment {
	text: string;
}

export interface FilteredTranscript<T extends TranscriptTextSegment> {
	text: string;
	segments: T[];
	removedCount: number;
}

function normalizePhrase(value: string): string {
	return value.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Filters whole segments so a short configured phrase cannot erase words inside legitimate speech. */
export function filterTranscriptArtifacts<T extends TranscriptTextSegment>(
	transcript: string,
	segments: readonly T[],
	configuredPhrases: string
): FilteredTranscript<T> {
	const ignoredPhrases = new Set(configuredPhrases.split(/\r?\n/).map(normalizePhrase).filter(Boolean));
	if (ignoredPhrases.size === 0) return { text: transcript, segments: [...segments], removedCount: 0 };

	if (segments.length > 0) {
		const keptSegments = segments.filter((segment) => !ignoredPhrases.has(normalizePhrase(segment.text)));
		const removedCount = segments.length - keptSegments.length;
		return {
			text: removedCount > 0 ? keptSegments.map((segment) => segment.text.trim()).filter(Boolean).join(" ") : transcript,
			segments: keptSegments,
			removedCount,
		};
	}

	const lines = transcript.split(/\r?\n/);
	const keptLines = lines.filter((line) => !ignoredPhrases.has(normalizePhrase(line)));
	return {
		text: keptLines.join("\n"),
		segments: [],
		removedCount: lines.length - keptLines.length,
	};
}
