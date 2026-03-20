/**
 * SDP utility helpers.
 *
 * Pure string-manipulation functions with no dependency on browser APIs –
 * all functions are fully unit-testable in a Node.js / jsdom environment.
 */

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface SdpSection {
	lines: string[];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Reorder codecs in an SDP offer so the preferred codec appears first in the
 * `m=<kind>` payload type list.
 *
 * The matching is case-insensitive. Associated RTX payload types are moved
 * together with their primary codec. Returns the SDP unchanged when the
 * codec is not present.
 *
 * @param sdp            Raw SDP string.
 * @param kind           `'audio'` or `'video'`.
 * @param preferredCodec Codec name – e.g. `'opus'`, `'H264'`, `'VP8'`.
 */
export const preferCodec = (
	sdp: string,
	kind: 'audio' | 'video',
	preferredCodec: string,
): string => {
	const sections = splitSections(sdp);

	for (const section of sections) {
		if (!isSectionKind(section, kind)) continue;
		section.lines = reorderCodecs(section.lines, preferredCodec);
	}

	return joinSections(sections);
};

/**
 * Add a bandwidth limit to the `m=<kind>` section of an SDP string.
 *
 * Writes both:
 * - `b=AS:<maxKbps>` (RFC 4566 – kbps, widely supported)
 * - `b=TIAS:<maxBps>` (RFC 3890 – bps, more precise)
 *
 * If a `b=` line already exists it is replaced. When `maxKbps` is `0` or
 * negative any existing bandwidth lines are removed.
 *
 * @param sdp      Raw SDP string.
 * @param kind     `'audio'` or `'video'`, or `'session'` to set the session-level limit.
 * @param maxKbps  Maximum bandwidth in **kilobits per second**.
 */
export const setBandwidth = (
	sdp: string,
	kind: 'audio' | 'video' | 'session',
	maxKbps: number,
): string => {
	const sections = splitSections(sdp);

	for (const section of sections) {
		const isTarget =
			kind === 'session' ? !section.lines[0]?.startsWith('m=') : isSectionKind(section, kind);

		if (!isTarget) continue;

		// Remove existing b= lines
		section.lines = section.lines.filter((l) => !l.startsWith('b='));

		if (maxKbps <= 0) break;

		// Insert b= lines after the c= line (or after the m= line if no c=)
		const insertIdx = findInsertIndex(section.lines);
		section.lines.splice(insertIdx, 0, `b=AS:${maxKbps}`, `b=TIAS:${maxKbps * 1000}`);
		break;
	}

	return joinSections(sections);
};

/**
 * Add simulcast send layers to the first `m=video` section of an SDP offer.
 *
 * Appends `a=rid` and `a=simulcast` lines for three quality tiers:
 * `high`, `mid`, and `low`. Safe to call when no `m=video` section is
 * present (SDP is returned unchanged). Idempotent – does nothing when the
 * section already contains an `a=simulcast` line.
 *
 * @param sdp Raw SDP offer string.
 */
export const addSimulcast = (sdp: string): string => {
	const sections = splitSections(sdp);

	for (const section of sections) {
		if (!isSectionKind(section, 'video')) continue;
		if (section.lines.some((l) => l.startsWith('a=simulcast'))) break;

		section.lines.push(
			'a=rid:high send',
			'a=rid:mid send',
			'a=rid:low send',
			'a=simulcast:send high;mid;low',
		);
		break;
	}

	return joinSections(sections);
};

/**
 * Patch `a=fmtp` attributes for the given codec in the `m=<kind>` section.
 *
 * Merges the provided key-value pairs into any existing `a=fmtp` line for
 * each matching payload type. Creates a new `a=fmtp` line if none exists.
 *
 * @param sdp    Raw SDP string.
 * @param kind   `'audio'` or `'video'`.
 * @param codec  Codec name used to locate the `a=rtpmap` line (e.g. `'opus'`).
 * @param params Key-value map merged into `a=fmtp` (e.g. `{ usedtx: 1, stereo: 1 }`).
 */
export const patchFmtp = (
	sdp: string,
	kind: 'audio' | 'video',
	codec: string,
	params: Record<string, string | number>,
): string => {
	const sections = splitSections(sdp);

	for (const section of sections) {
		if (!isSectionKind(section, kind)) continue;

		// Find all payload types for this codec
		const pts = new Set<string>();
		for (const line of section.lines) {
			const match = /^a=rtpmap:(\d+) ([^/]+)/.exec(line);
			if (match && match[2]?.toLowerCase() === codec.toLowerCase() && match[1] !== undefined)
				pts.add(match[1]);
		}

		if (pts.size === 0) break;

		const newParams = Object.entries(params)
			.map(([k, v]) => `${k}=${v}`)
			.join(';');

		const updatedLines: string[] = [];
		const handledPts = new Set<string>();

		for (const line of section.lines) {
			const fmtpMatch = /^a=fmtp:(\d+) (.*)$/.exec(line);

			if (fmtpMatch && fmtpMatch[1] !== undefined && pts.has(fmtpMatch[1])) {
				const pt = fmtpMatch[1];
				const merged = mergeFmtp(fmtpMatch[2] ?? '', newParams);
				updatedLines.push(`a=fmtp:${pt} ${merged}`);
				handledPts.add(pt);
				continue;
			}

			updatedLines.push(line);

			// Insert new a=fmtp after the corresponding a=rtpmap line
			const rtpmapMatch = /^a=rtpmap:(\d+)/.exec(line);
			if (
				rtpmapMatch &&
				rtpmapMatch[1] !== undefined &&
				pts.has(rtpmapMatch[1]) &&
				!handledPts.has(rtpmapMatch[1])
			) {
				updatedLines.push(`a=fmtp:${rtpmapMatch[1]} ${newParams}`);
				handledPts.add(rtpmapMatch[1]);
			}
		}

		section.lines = updatedLines;
		break;
	}

	return joinSections(sections);
};

/**
 * Extract the SSRC value from the first `a=ssrc` line in the `m=<kind>`
 * section. Returns `undefined` when not found.
 */
export const extractSsrc = (sdp: string, kind: 'audio' | 'video'): number | undefined => {
	const sections = splitSections(sdp);

	for (const section of sections) {
		if (!isSectionKind(section, kind)) continue;

		for (const line of section.lines) {
			const match = /^a=ssrc:(\d+)/.exec(line);
			if (match?.[1] !== undefined) return Number(match[1]);
		}
	}

	return undefined;
};

/**
 * Strip all `a=extmap` lines referencing a specific URI from an SDP.
 * Useful for removing unsupported RTP header extensions.
 */
export const removeExtmap = (sdp: string, uri: string): string =>
	sdp
		.split('\r\n')
		.filter((line) => !(line.startsWith('a=extmap') && line.includes(uri)))
		.join('\r\n');

/**
 * Return all codec names found in the given `m=<kind>` section.
 * Codec names are derived from `a=rtpmap` lines (e.g. `'opus'`, `'VP8'`).
 */
export const listCodecs = (sdp: string, kind: 'audio' | 'video'): string[] => {
	const sections = splitSections(sdp);

	for (const section of sections) {
		if (!isSectionKind(section, kind)) continue;

		const codecs: string[] = [];
		for (const line of section.lines) {
			const match = /^a=rtpmap:\d+ ([^/]+)/.exec(line);
			if (match?.[1] !== undefined) codecs.push(match[1]);
		}
		return codecs;
	}

	return [];
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const splitSections = (sdp: string): SdpSection[] => {
	const sections: SdpSection[] = [];
	let current: string[] = [];

	for (const line of sdp.split('\r\n')) {
		if (line.startsWith('m=') && current.length > 0) {
			sections.push({ lines: current });
			current = [];
		}
		current.push(line);
	}

	if (current.length > 0) sections.push({ lines: current });

	return sections;
};

const joinSections = (sections: SdpSection[]): string =>
	sections.map((s) => s.lines.join('\r\n')).join('\r\n');

const isSectionKind = (section: SdpSection, kind: 'audio' | 'video'): boolean =>
	section.lines[0]?.startsWith(`m=${kind}`) ?? false;

/**
 * Find the correct index to insert `b=` lines within a section.
 * Per RFC 4566 they must follow the `c=` line (or the `m=` line when `c=`
 * is absent).
 */
const findInsertIndex = (lines: string[]): number => {
	const cIdx = lines.findIndex((l) => l.startsWith('c='));
	if (cIdx !== -1) return cIdx + 1;

	const mIdx = lines.findIndex((l) => l.startsWith('m='));
	if (mIdx !== -1) return mIdx + 1;

	return 1;
};

/**
 * Move the preferred codec payload types to the front of the `m=` line and
 * reorder the associated `a=rtpmap` / `a=fmtp` / `a=rtcp-fb` lines to
 * appear first among the attribute block.
 */
const reorderCodecs = (lines: string[], preferredCodec: string): string[] => {
	const mLine = lines[0];
	if (!mLine) return lines;

	// Collect primary payload types that match the codec name
	const preferredPts = new Set<string>();
	for (const line of lines) {
		const match = /^a=rtpmap:(\d+) ([^/]+)/.exec(line);
		if (
			match &&
			match[2]?.toLowerCase() === preferredCodec.toLowerCase() &&
			match[1] !== undefined
		)
			preferredPts.add(match[1]);
	}

	if (preferredPts.size === 0) return lines;

	// Include associated RTX / RED / FEC payload types
	const relatedPts = new Set<string>(preferredPts);
	for (const line of lines) {
		const match = /^a=fmtp:(\d+) apt=(\d+)/.exec(line);
		if (match && match[2] !== undefined && preferredPts.has(match[2]) && match[1] !== undefined)
			relatedPts.add(match[1]);
	}

	// Rewrite the m= line with preferred PTs first
	const parts = mLine.split(' ');
	if (parts.length < 4) return lines;

	const prefix = parts.slice(0, 3) as [string, string, string];
	const allPts = parts.slice(3);
	const reordered = [
		...allPts.filter((pt) => relatedPts.has(pt)),
		...allPts.filter((pt) => !relatedPts.has(pt)),
	];

	const newMLine = [...prefix, ...reordered].join(' ');

	// Move matching attribute lines to the top of the attribute block
	const attrLines = lines.slice(1);
	const preferredAttrs = attrLines.filter((l) => {
		const pt = extractPtFromAttr(l);
		return pt !== null && relatedPts.has(pt);
	});
	const otherAttrs = attrLines.filter((l) => {
		const pt = extractPtFromAttr(l);
		return pt === null || !relatedPts.has(pt);
	});

	return [newMLine, ...preferredAttrs, ...otherAttrs];
};

const extractPtFromAttr = (line: string): string | null => {
	const match = /^a=(?:rtpmap|fmtp|rtcp-fb):(\d+)/.exec(line);
	return match?.[1] ?? null;
};

/**
 * Merge two `a=fmtp` parameter strings.
 * Keys from `incoming` override keys in `base`.
 *
 * @example mergeFmtp('minptime=10;useinbandfec=1', 'usedtx=1') => 'minptime=10;useinbandfec=1;usedtx=1'
 */
const mergeFmtp = (base: string, incoming: string): string => {
	const parse = (s: string): Map<string, string> => {
		const map = new Map<string, string>();
		for (const pair of s.split(';')) {
			const [k, v = ''] = pair.split('=');
			if (k?.trim()) map.set(k.trim(), v.trim());
		}
		return map;
	};

	const merged = new Map([...parse(base), ...parse(incoming)]);
	return [...merged.entries()].map(([k, v]) => (v ? `${k}=${v}` : k)).join(';');
};
