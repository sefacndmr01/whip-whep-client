import { describe, it, expect } from 'vitest';
import { computeQuality } from '../../src/utils/stats.js';

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
