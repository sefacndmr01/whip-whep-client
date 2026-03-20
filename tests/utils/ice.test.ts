import { describe, it, expect, vi } from 'vitest';
import { setupIceTrickle, waitForIceGathering } from '../../src/utils/ice.js';

// ---------------------------------------------------------------------------
// Minimal RTCPeerConnection mock for ICE tests
// ---------------------------------------------------------------------------

function makeMockPc(initialGatheringState: RTCIceGatheringState = 'new') {
	const listeners = new Map<string, Set<(e: Event) => void>>();

	const pc = {
		iceGatheringState: initialGatheringState as RTCIceGatheringState,
		addEventListener(type: string, fn: (e: Event) => void) {
			if (!listeners.has(type)) listeners.set(type, new Set());
			listeners.get(type)!.add(fn);
		},
		removeEventListener(type: string, fn: (e: Event) => void) {
			listeners.get(type)?.delete(fn);
		},
		dispatch(type: string, event: Event) {
			listeners.get(type)?.forEach((fn) => fn(event));
		},
	};

	return pc;
}

function makeIceCandidateEvent(candidate: RTCIceCandidate | null): RTCPeerConnectionIceEvent {
	return Object.assign(new Event('icecandidate'), { candidate }) as RTCPeerConnectionIceEvent;
}

// ---------------------------------------------------------------------------
// setupIceTrickle
// ---------------------------------------------------------------------------

describe('setupIceTrickle', () => {
	it('buffers candidates in end-of-candidates mode and flushes on null candidate', async () => {
		const pc = makeMockPc() as unknown as RTCPeerConnection;
		const onCandidates = vi.fn().mockResolvedValue(undefined);

		setupIceTrickle(pc, { mode: 'end-of-candidates', onCandidates });

		const c1 = { candidate: 'candidate:1 ...' } as unknown as RTCIceCandidate;
		const c2 = { candidate: 'candidate:2 ...' } as unknown as RTCIceCandidate;

		(pc as unknown as ReturnType<typeof makeMockPc>).dispatch(
			'icecandidate',
			makeIceCandidateEvent(c1),
		);
		(pc as unknown as ReturnType<typeof makeMockPc>).dispatch(
			'icecandidate',
			makeIceCandidateEvent(c2),
		);

		// Not called yet – buffer not flushed
		expect(onCandidates).not.toHaveBeenCalled();

		// Null candidate triggers flush
		(pc as unknown as ReturnType<typeof makeMockPc>).dispatch(
			'icecandidate',
			makeIceCandidateEvent(null),
		);

		expect(onCandidates).toHaveBeenCalledOnce();
		expect(onCandidates.mock.calls[0]![0]).toHaveLength(2);
	});

	it('flushes buffer when iceGatheringState becomes complete', async () => {
		const pcRaw = makeMockPc();
		const pc = pcRaw as unknown as RTCPeerConnection;
		const onCandidates = vi.fn().mockResolvedValue(undefined);

		setupIceTrickle(pc, { mode: 'end-of-candidates', onCandidates });

		const c = { candidate: 'candidate:1 ...' } as unknown as RTCIceCandidate;
		pcRaw.dispatch('icecandidate', makeIceCandidateEvent(c));

		// Simulate gathering complete
		pcRaw.iceGatheringState = 'complete';
		pcRaw.dispatch('icegatheringstatechange', new Event('icegatheringstatechange'));

		expect(onCandidates).toHaveBeenCalledOnce();
		expect(onCandidates.mock.calls[0]![0]).toHaveLength(1);
	});

	it('calls onCandidates immediately in immediate mode', async () => {
		const pc = makeMockPc() as unknown as RTCPeerConnection;
		const onCandidates = vi.fn().mockResolvedValue(undefined);

		setupIceTrickle(pc, { mode: 'immediate', onCandidates });

		const c = { candidate: 'candidate:1 ...' } as unknown as RTCIceCandidate;
		(pc as unknown as ReturnType<typeof makeMockPc>).dispatch(
			'icecandidate',
			makeIceCandidateEvent(c),
		);

		expect(onCandidates).toHaveBeenCalledOnce();
		expect(onCandidates.mock.calls[0]![0]).toEqual([c]);
	});

	it('calls onGatheringComplete when gathering is done', () => {
		const pcRaw = makeMockPc();
		const pc = pcRaw as unknown as RTCPeerConnection;
		const onGatheringComplete = vi.fn();

		setupIceTrickle(pc, {
			mode: 'end-of-candidates',
			onCandidates: vi.fn().mockResolvedValue(undefined),
			onGatheringComplete,
		});

		pcRaw.iceGatheringState = 'complete';
		pcRaw.dispatch('icegatheringstatechange', new Event('icegatheringstatechange'));

		expect(onGatheringComplete).toHaveBeenCalledOnce();
	});

	it('cleanup function removes event listeners', () => {
		const pcRaw = makeMockPc();
		const pc = pcRaw as unknown as RTCPeerConnection;
		const onCandidates = vi.fn().mockResolvedValue(undefined);

		const cleanup = setupIceTrickle(pc, { mode: 'immediate', onCandidates });
		cleanup();

		const c = { candidate: 'candidate:1 ...' } as unknown as RTCIceCandidate;
		pcRaw.dispatch('icecandidate', makeIceCandidateEvent(c));

		// Should not be called after cleanup
		expect(onCandidates).not.toHaveBeenCalled();
	});

	it('defaults to end-of-candidates mode when mode is omitted', () => {
		const pc = makeMockPc() as unknown as RTCPeerConnection;
		const onCandidates = vi.fn().mockResolvedValue(undefined);

		// No mode specified → should buffer
		setupIceTrickle(pc, { onCandidates });

		const c = { candidate: 'candidate:1 ...' } as unknown as RTCIceCandidate;
		(pc as unknown as ReturnType<typeof makeMockPc>).dispatch(
			'icecandidate',
			makeIceCandidateEvent(c),
		);

		// Not flushed yet
		expect(onCandidates).not.toHaveBeenCalled();
	});

	it('does not call onCandidates when buffer is empty at gathering complete', () => {
		const pcRaw = makeMockPc();
		const pc = pcRaw as unknown as RTCPeerConnection;
		const onCandidates = vi.fn().mockResolvedValue(undefined);

		setupIceTrickle(pc, { mode: 'end-of-candidates', onCandidates });

		// No candidates were emitted
		pcRaw.iceGatheringState = 'complete';
		pcRaw.dispatch('icegatheringstatechange', new Event('icegatheringstatechange'));

		expect(onCandidates).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// waitForIceGathering
// ---------------------------------------------------------------------------

describe('waitForIceGathering', () => {
	it('resolves immediately when already complete', async () => {
		const pc = makeMockPc('complete') as unknown as RTCPeerConnection;
		await expect(waitForIceGathering(pc)).resolves.toBeUndefined();
	});

	it('resolves when gathering reaches complete', async () => {
		const pcRaw = makeMockPc('gathering');
		const pc = pcRaw as unknown as RTCPeerConnection;

		const promise = waitForIceGathering(pc, 1000);

		pcRaw.iceGatheringState = 'complete';
		pcRaw.dispatch('icegatheringstatechange', new Event('icegatheringstatechange'));

		await expect(promise).resolves.toBeUndefined();
	});

	it('rejects after timeout when gathering does not complete', async () => {
		const pc = makeMockPc('gathering') as unknown as RTCPeerConnection;

		await expect(waitForIceGathering(pc, 50)).rejects.toThrow(
			'ICE gathering timed out after 50ms',
		);
	});

	it('does not reject if already resolved before timeout fires', async () => {
		const pcRaw = makeMockPc('gathering');
		const pc = pcRaw as unknown as RTCPeerConnection;

		const promise = waitForIceGathering(pc, 500);

		// Resolve quickly
		pcRaw.iceGatheringState = 'complete';
		pcRaw.dispatch('icegatheringstatechange', new Event('icegatheringstatechange'));

		await expect(promise).resolves.toBeUndefined();
	});
});
