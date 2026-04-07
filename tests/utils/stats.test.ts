import { describe, it, expect } from 'vitest';
import { computeQuality, StatsHistoryImpl } from '../../src/utils/stats.js';
import type { StreamStats } from '../../src/core/types.js';

const makeStats = (
	videoBitrate: number,
	audioBitrate: number,
	lossRate = 0,
	rtt: number | null = null,
): StreamStats => ({
	timestamp: Date.now(),
	audio: { bitrate: audioBitrate, packetsLost: 0, packetsLostRate: lossRate, jitter: 0 },
	video: {
		bitrate: videoBitrate,
		packetsLost: 0,
		packetsLostRate: lossRate,
		frameRate: 30,
		width: 1280,
		height: 720,
	},
	roundTripTime: rtt,
	quality: 'excellent',
});

describe('StatsHistoryImpl', () => {
	it('starts empty', () => {
		const h = new StatsHistoryImpl(5);
		expect(h.snapshots).toHaveLength(0);
		expect(h.prev).toBeNull();
	});

	it('prev is null after first push', () => {
		const h = new StatsHistoryImpl(5);
		h.push(makeStats(1000, 500));
		expect(h.prev).toBeNull();
	});

	it('prev returns the second-to-last snapshot after two pushes', () => {
		const h = new StatsHistoryImpl(5);
		const a = makeStats(1000, 500);
		const b = makeStats(2000, 600);
		h.push(a);
		h.push(b);
		expect(h.prev).toBe(a);
	});

	it('evicts oldest entry when historySize is exceeded', () => {
		const h = new StatsHistoryImpl(3);
		const s = [makeStats(100, 50), makeStats(200, 60), makeStats(300, 70), makeStats(400, 80)];
		for (const snap of s) h.push(snap);
		expect(h.snapshots).toHaveLength(3);
		expect(h.snapshots[0]).toBe(s[1]);
		expect(h.snapshots[2]).toBe(s[3]);
	});

	it('avgVideoBitrate averages across window', () => {
		const h = new StatsHistoryImpl(10);
		h.push(makeStats(1000, 0));
		h.push(makeStats(3000, 0));
		expect(h.avgVideoBitrate()).toBe(2000);
	});

	it('avgAudioBitrate averages across window', () => {
		const h = new StatsHistoryImpl(10);
		h.push(makeStats(0, 100));
		h.push(makeStats(0, 300));
		expect(h.avgAudioBitrate()).toBe(200);
	});

	it('avgPacketLossRate averages audio and video loss rates', () => {
		const h = new StatsHistoryImpl(10);
		h.push(makeStats(1000, 500, 0.1));
		expect(h.avgPacketLossRate()).toBeCloseTo(0.1);
	});

	it('avgRoundTripTime skips null values', () => {
		const h = new StatsHistoryImpl(10);
		h.push(makeStats(1000, 500, 0, null));
		h.push(makeStats(1000, 500, 0, 0.1));
		h.push(makeStats(1000, 500, 0, 0.3));
		expect(h.avgRoundTripTime()).toBeCloseTo(0.2);
	});

	it('returns null from helpers when no snapshots', () => {
		const h = new StatsHistoryImpl(10);
		expect(h.avgVideoBitrate()).toBeNull();
		expect(h.avgAudioBitrate()).toBeNull();
		expect(h.avgPacketLossRate()).toBeNull();
		expect(h.avgRoundTripTime()).toBeNull();
	});

	it('returns null from avgRoundTripTime when all values are null', () => {
		const h = new StatsHistoryImpl(10);
		h.push(makeStats(1000, 500, 0, null));
		expect(h.avgRoundTripTime()).toBeNull();
	});
});

describe('computeQuality', () => {
	// ---- excellent ----------------------------------------------------------

	it('returns excellent for 0% loss and 0 ms RTT', () => {
		expect(computeQuality(0, 0)).toBe('excellent');
	});

	it('returns excellent for low loss and low RTT', () => {
		expect(computeQuality(0.005, 0.04)).toBe('excellent');
	});

	it('returns excellent for exactly 0.99% loss and 49 ms RTT', () => {
		expect(computeQuality(0.0099, 0.049)).toBe('excellent');
	});

	// ---- good ---------------------------------------------------------------

	it('returns good when loss < 3% and RTT < 150 ms', () => {
		expect(computeQuality(0.02, 0.1)).toBe('good');
	});

	it('returns good when loss is at the excellent/good boundary (1%)', () => {
		expect(computeQuality(0.01, 0.04)).toBe('good');
	});

	it('returns good when RTT is at the excellent/good boundary (50 ms)', () => {
		expect(computeQuality(0.005, 0.05)).toBe('good');
	});

	// ---- fair ---------------------------------------------------------------

	it('returns fair when loss < 8% and RTT < 300 ms', () => {
		expect(computeQuality(0.05, 0.2)).toBe('fair');
	});

	it('returns fair when loss is at the good/fair boundary (3%)', () => {
		expect(computeQuality(0.03, 0.1)).toBe('fair');
	});

	it('returns fair when RTT is at the good/fair boundary (150 ms)', () => {
		expect(computeQuality(0.02, 0.15)).toBe('fair');
	});

	// ---- poor ---------------------------------------------------------------

	it('returns poor when loss >= 8%', () => {
		expect(computeQuality(0.08, 0)).toBe('poor');
	});

	it('returns poor when RTT >= 300 ms', () => {
		expect(computeQuality(0, 0.3)).toBe('poor');
	});

	it('returns poor for high loss and high RTT', () => {
		expect(computeQuality(0.5, 1)).toBe('poor');
	});

	// ---- null RTT (only loss used) ------------------------------------------

	it('returns excellent for low loss when RTT is null', () => {
		expect(computeQuality(0.005, null)).toBe('excellent');
	});

	it('returns good for 2% loss when RTT is null', () => {
		expect(computeQuality(0.02, null)).toBe('good');
	});

	it('returns fair for 5% loss when RTT is null', () => {
		expect(computeQuality(0.05, null)).toBe('fair');
	});

	it('returns poor for 10% loss when RTT is null', () => {
		expect(computeQuality(0.1, null)).toBe('poor');
	});

	// ---- AND semantics: both conditions must be met -------------------------

	it('returns fair when loss is low but RTT is between 150–300 ms', () => {
		// loss < 0.01 (would be excellent) but RTT = 200 ms disqualifies excellent & good
		expect(computeQuality(0.005, 0.2)).toBe('fair');
	});

	it('returns fair when RTT is low but loss is between 3–8%', () => {
		// RTT = 10 ms (would be excellent) but loss = 4% disqualifies excellent & good
		expect(computeQuality(0.04, 0.01)).toBe('fair');
	});

	it('returns poor when loss is low but RTT is >= 300 ms', () => {
		expect(computeQuality(0, 0.5)).toBe('poor');
	});
});
