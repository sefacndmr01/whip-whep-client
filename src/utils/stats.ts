import type { ConnectionQuality } from '../core/types.js';

// ---------------------------------------------------------------------------
// StatsSnapshot (shared by WHIPClient and WHEPClient)
// ---------------------------------------------------------------------------

/**
 * Minimal byte-count snapshot used to compute delta bitrates between two
 * consecutive `getStats()` calls.
 */
export interface StatsSnapshot {
	timestamp: number;
	audioBytes: number;
	videoBytes: number;
}

// ---------------------------------------------------------------------------
// computeQuality
// ---------------------------------------------------------------------------

/**
 * Derive a `ConnectionQuality` label from the packet-loss rate and
 * round-trip time.
 *
 * | Quality   | Packet-loss rate | RTT       |
 * |-----------|-----------------|-----------|
 * | excellent | < 1 %           | < 50 ms   |
 * | good      | < 3 %           | < 150 ms  |
 * | fair      | < 8 %           | < 300 ms  |
 * | poor      | ≥ 8 %           | ≥ 300 ms  |
 *
 * When `rttSeconds` is `null` (no measurement available yet), only the
 * packet-loss rate is used.
 *
 * @param lossRate   Fraction of lost packets (0–1).
 * @param rttSeconds Round-trip time in seconds, or `null`.
 */
export const computeQuality = (lossRate: number, rttSeconds: number | null): ConnectionQuality => {
	if (rttSeconds === null) {
		if (lossRate < 0.01) return 'excellent';
		if (lossRate < 0.03) return 'good';
		if (lossRate < 0.08) return 'fair';
		return 'poor';
	}

	const rttMs = rttSeconds * 1000;
	if (lossRate < 0.01 && rttMs < 50) return 'excellent';
	if (lossRate < 0.03 && rttMs < 150) return 'good';
	if (lossRate < 0.08 && rttMs < 300) return 'fair';
	return 'poor';
};
