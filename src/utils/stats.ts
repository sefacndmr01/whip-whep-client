import type { ConnectionQuality, StatsHistory, StreamStats } from '../core/types.js';

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
// StatsHistoryImpl
// ---------------------------------------------------------------------------

/** @internal */
export class StatsHistoryImpl implements StatsHistory {
	private readonly _buf: StreamStats[] = [];
	private readonly _max: number;

	constructor(maxSize: number) {
		this._max = maxSize;
	}

	push(snapshot: StreamStats): void {
		this._buf.push(snapshot);
		if (this._buf.length > this._max) this._buf.shift();
	}

	get snapshots(): ReadonlyArray<StreamStats> {
		return this._buf;
	}

	get prev(): StreamStats | null {
		return this._buf.length >= 2 ? (this._buf[this._buf.length - 2] ?? null) : null;
	}

	avgVideoBitrate(): number | null {
		return avg(this._buf.map((s) => s.video?.bitrate));
	}

	avgAudioBitrate(): number | null {
		return avg(this._buf.map((s) => s.audio?.bitrate));
	}

	avgPacketLossRate(): number | null {
		const rates: number[] = [];
		for (const s of this._buf) {
			if (s.audio != null) rates.push(s.audio.packetsLostRate);
			if (s.video != null) rates.push(s.video.packetsLostRate);
		}
		return avg(rates);
	}

	avgRoundTripTime(): number | null {
		return avg(this._buf.map((s) => s.roundTripTime));
	}
}

const avg = (values: Array<number | null | undefined>): number | null => {
	const nums = values.filter((v): v is number => v != null);
	return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
};

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
