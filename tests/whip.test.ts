import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WHIPClient } from '../src/whip/WHIPClient.js';
import { WHIPError, InvalidStateError } from '../src/core/errors.js';
import type { MockRTCPeerConnection } from './setup.js';
import { MOCK_SDP_ANSWER, MockRTCRtpSender } from './setup.js';
import type { StreamStats } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockStream(kinds: Array<'audio' | 'video'> = ['audio', 'video']): MediaStream {
	const tracks = kinds.map((kind) => ({
		kind,
		stop: vi.fn(),
		id: `mock-${kind}`,
		enabled: true,
	})) as unknown as MediaStreamTrack[];

	const stream = new MediaStream();
	tracks.forEach((t) => stream.addTrack(t));
	return stream;
}

function mockFetchSuccess(status = 201, body = MOCK_SDP_ANSWER, location = '/whip/resource/1') {
	return vi.fn().mockResolvedValue({
		status,
		statusText: 'Created',
		text: () => Promise.resolve(body),
		headers: new Headers({ Location: location }),
	});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WHIPClient', () => {
	let fetchSpy: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		fetchSpy = mockFetchSuccess();
		vi.stubGlobal('fetch', fetchSpy);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	// ---- Constructor ---------------------------------------------------------

	it('starts in idle state', () => {
		const client = new WHIPClient({ endpoint: 'https://example.com/whip' });
		expect(client.state).toBe('idle');
		expect(client.resource).toBeNull();
	});

	// ---- publish() -----------------------------------------------------------

	it('transitions to connected state after successful publish', async () => {
		const client = new WHIPClient({ endpoint: 'https://example.com/whip' });
		const stream = makeMockStream();

		await client.publish(stream);

		// Wait for async connection state change
		await new Promise((r) => setTimeout(r, 10));

		expect(client.state).toBe('connected');
	});

	it('sets resource URL from Location header', async () => {
		const client = new WHIPClient({ endpoint: 'https://example.com/whip' });
		const stream = makeMockStream();

		await client.publish(stream);

		expect(client.resource).toBe('https://example.com/whip/resource/1');
	});

	it('sends Authorization header when token provided', async () => {
		const client = new WHIPClient({
			endpoint: 'https://example.com/whip',
			token: 'my-secret',
		});

		await client.publish(makeMockStream());

		const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
		const headers = init.headers as Headers;
		expect(headers.get('Authorization')).toBe('Bearer my-secret');
	});

	it('POSTs SDP offer to the endpoint', async () => {
		const client = new WHIPClient({ endpoint: 'https://example.com/whip' });
		await client.publish(makeMockStream());

		expect(fetchSpy).toHaveBeenCalledWith(
			'https://example.com/whip',
			expect.objectContaining({ method: 'POST' }),
		);
	});

	it('emits connected event', async () => {
		const client = new WHIPClient({ endpoint: 'https://example.com/whip' });
		const onConnected = vi.fn();
		client.on('connected', onConnected);

		await client.publish(makeMockStream());
		await new Promise((r) => setTimeout(r, 10));

		expect(onConnected).toHaveBeenCalledOnce();
	});

	it('throws WHIPError when server returns non-201', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue({
				status: 403,
				statusText: 'Forbidden',
				text: () => Promise.resolve('Access denied'),
				headers: new Headers(),
			}),
		);

		const client = new WHIPClient({ endpoint: 'https://example.com/whip' });

		await expect(client.publish(makeMockStream())).rejects.toThrow(WHIPError);
	});

	it('throws InvalidStateError when publish() called twice', async () => {
		const client = new WHIPClient({ endpoint: 'https://example.com/whip' });
		await client.publish(makeMockStream());

		await expect(client.publish(makeMockStream())).rejects.toThrow(InvalidStateError);
	});

	it('emits failed when connection fails', async () => {
		const client = new WHIPClient({ endpoint: 'https://example.com/whip' });
		const onFailed = vi.fn();
		client.on('failed', onFailed);

		await client.publish(makeMockStream());

		// Simulate connection failure via the mock PC
		const pc = (client as unknown as { pc: MockRTCPeerConnection }).pc!;
		pc.connectionState = 'failed';
		pc.dispatchEvent('connectionstatechange', new Event('connectionstatechange'));

		expect(onFailed).toHaveBeenCalledOnce();
	});

	// ---- stop() --------------------------------------------------------------

	it('sends DELETE request on stop()', async () => {
		vi.stubGlobal(
			'fetch',
			vi
				.fn()
				.mockResolvedValueOnce({
					status: 201,
					statusText: 'Created',
					text: () => Promise.resolve(MOCK_SDP_ANSWER),
					headers: new Headers({ Location: '/whip/resource/1' }),
				})
				.mockResolvedValueOnce({ status: 200, headers: new Headers() }),
		);

		const client = new WHIPClient({ endpoint: 'https://example.com/whip' });
		await client.publish(makeMockStream());
		await client.stop();

		const calls = (vi.mocked(fetch) as ReturnType<typeof vi.fn>).mock.calls;
		const deleteCall = calls.find(([, init]) => (init as RequestInit).method === 'DELETE');
		expect(deleteCall).toBeDefined();
	});

	it('transitions to closed state after stop()', async () => {
		const client = new WHIPClient({ endpoint: 'https://example.com/whip' });
		await client.publish(makeMockStream());
		await client.stop();

		expect(client.state).toBe('closed');
		expect(client.resource).toBeNull();
	});

	it('stop() is safe to call multiple times', async () => {
		const client = new WHIPClient({ endpoint: 'https://example.com/whip' });
		await client.publish(makeMockStream());
		await client.stop();
		await expect(client.stop()).resolves.toBeUndefined();
	});

	// ---- Codec options -------------------------------------------------------

	it('applies audio codec preference to SDP offer', async () => {
		const client = new WHIPClient({
			endpoint: 'https://example.com/whip',
			audioCodec: 'ISAC',
		});

		await client.publish(makeMockStream());

		const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
		const body = init.body as string;
		const audioMLine = body.split('\r\n').find((l: string) => l.startsWith('m=audio'));
		// ISAC is pt 103 in our mock SDP
		expect(audioMLine).toMatch(/^m=audio \S+ \S+ 103/);
	});

	// ---- Simulcast -----------------------------------------------------------

	it('adds simulcast attributes when simulcast option is true', async () => {
		const client = new WHIPClient({
			endpoint: 'https://example.com/whip',
			simulcast: true,
		});

		await client.publish(makeMockStream());

		const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
		const body = init.body as string;
		expect(body).toContain('a=simulcast:send high;mid;low');
	});

	// ---- replaceTrack() ------------------------------------------------------

	it('replaceTrack replaces the active sender track', async () => {
		const client = new WHIPClient({ endpoint: 'https://example.com/whip' });
		await client.publish(makeMockStream());

		const newTrack = {
			kind: 'video',
			stop: vi.fn(),
			id: 'new-video',
		} as unknown as MediaStreamTrack;
		await client.replaceTrack('video', newTrack);

		const pc = (client as unknown as { pc: MockRTCPeerConnection }).pc!;
		const sender = pc
			.getSenders()
			.find((s) => s instanceof MockRTCRtpSender && s.track?.id === 'new-video');
		expect(sender).toBeDefined();
	});

	it('replaceTrack updates _lastStream with the new track', async () => {
		const client = new WHIPClient({ endpoint: 'https://example.com/whip' });
		await client.publish(makeMockStream(['audio', 'video']));

		const newTrack = {
			kind: 'audio',
			stop: vi.fn(),
			id: 'new-audio',
			contentHint: '',
		} as unknown as MediaStreamTrack;
		await client.replaceTrack('audio', newTrack);

		const lastStream = (client as unknown as { _lastStream: MediaStream })._lastStream!;
		expect(lastStream.getAudioTracks().find((t) => t.id === 'new-audio')).toBeDefined();
	});

	it('replaceTrack throws InvalidStateError when no active peer connection', async () => {
		const client = new WHIPClient({ endpoint: 'https://example.com/whip' });
		const newTrack = { kind: 'video', stop: vi.fn(), id: 'v' } as unknown as MediaStreamTrack;

		await expect(client.replaceTrack('video', newTrack)).rejects.toThrow(InvalidStateError);
	});

	it('replaceTrack throws InvalidStateError when no sender for kind', async () => {
		const client = new WHIPClient({ endpoint: 'https://example.com/whip' });
		// Publish audio-only stream → no video sender
		await client.publish(makeMockStream(['audio']));

		const newTrack = { kind: 'video', stop: vi.fn(), id: 'v' } as unknown as MediaStreamTrack;
		await expect(client.replaceTrack('video', newTrack)).rejects.toThrow(InvalidStateError);
	});

	// ---- getStats() ----------------------------------------------------------

	it('getStats throws InvalidStateError when no active peer connection', async () => {
		const client = new WHIPClient({ endpoint: 'https://example.com/whip' });
		await expect(client.getStats()).rejects.toThrow(InvalidStateError);
	});

	it('getStats returns null audio/video on first call (no previous snapshot)', async () => {
		const client = new WHIPClient({ endpoint: 'https://example.com/whip' });
		await client.publish(makeMockStream());

		// Set up mock stats: 1000 bytes sent for audio, 5000 for video
		const pc = (client as unknown as { pc: MockRTCPeerConnection }).pc!;
		pc.setMockStats(
			new Map([
				[
					'outbound-audio',
					{ type: 'outbound-rtp', kind: 'audio', bytesSent: 0, packetsSent: 0 },
				],
				[
					'outbound-video',
					{ type: 'outbound-rtp', kind: 'video', bytesSent: 0, packetsSent: 0 },
				],
			]),
		);

		const stats = await client.getStats();
		// No bytes yet → null audio and video
		expect(stats.audio).toBeNull();
		expect(stats.video).toBeNull();
	});

	it('getStats computes bitrate delta between two calls', async () => {
		const client = new WHIPClient({ endpoint: 'https://example.com/whip' });
		await client.publish(makeMockStream());

		const pc = (client as unknown as { pc: MockRTCPeerConnection }).pc!;

		// First call establishes the baseline snapshot
		pc.setMockStats(
			new Map([
				['a', { type: 'outbound-rtp', kind: 'audio', bytesSent: 1000, packetsSent: 100 }],
				[
					'v',
					{
						type: 'outbound-rtp',
						kind: 'video',
						bytesSent: 10000,
						packetsSent: 200,
						framesPerSecond: 30,
						frameWidth: 1280,
						frameHeight: 720,
					},
				],
			]),
		);
		await client.getStats();

		// Wait briefly then call again with more bytes
		await new Promise((r) => setTimeout(r, 50));

		pc.setMockStats(
			new Map([
				['a', { type: 'outbound-rtp', kind: 'audio', bytesSent: 2000, packetsSent: 110 }],
				[
					'v',
					{
						type: 'outbound-rtp',
						kind: 'video',
						bytesSent: 60000,
						packetsSent: 210,
						framesPerSecond: 30,
						frameWidth: 1280,
						frameHeight: 720,
					},
				],
			]),
		);
		const stats = await client.getStats();

		expect(stats.audio).not.toBeNull();
		expect(stats.video).not.toBeNull();
		expect(stats.audio!.bitrate).toBeGreaterThan(0);
		expect(stats.video!.bitrate).toBeGreaterThan(0);
		expect(stats.video!.frameRate).toBe(30);
		expect(stats.video!.width).toBe(1280);
		expect(stats.video!.height).toBe(720);
	});

	it('getStats aggregates video bytes across simulcast layers', async () => {
		const client = new WHIPClient({ endpoint: 'https://example.com/whip', simulcast: true });
		await client.publish(makeMockStream());

		const pc = (client as unknown as { pc: MockRTCPeerConnection }).pc!;

		// Baseline
		pc.setMockStats(
			new Map([
				[
					'v-high',
					{ type: 'outbound-rtp', kind: 'video', bytesSent: 1000, packetsSent: 10 },
				],
				['v-mid', { type: 'outbound-rtp', kind: 'video', bytesSent: 500, packetsSent: 5 }],
				['v-low', { type: 'outbound-rtp', kind: 'video', bytesSent: 200, packetsSent: 2 }],
			]),
		);
		await client.getStats();

		await new Promise((r) => setTimeout(r, 50));

		// Each layer sends more bytes
		pc.setMockStats(
			new Map([
				[
					'v-high',
					{ type: 'outbound-rtp', kind: 'video', bytesSent: 3000, packetsSent: 30 },
				],
				[
					'v-mid',
					{ type: 'outbound-rtp', kind: 'video', bytesSent: 1500, packetsSent: 15 },
				],
				['v-low', { type: 'outbound-rtp', kind: 'video', bytesSent: 600, packetsSent: 6 }],
			]),
		);
		const stats = await client.getStats();

		// Aggregated: (3000+1500+600) = 5100 total, delta = 5100-1700 = 3400 bytes
		expect(stats.video).not.toBeNull();
		expect(stats.video!.bitrate).toBeGreaterThan(0);
	});

	it('getStats quality reflects loss rate', async () => {
		const client = new WHIPClient({ endpoint: 'https://example.com/whip' });
		await client.publish(makeMockStream());

		const pc = (client as unknown as { pc: MockRTCPeerConnection }).pc!;
		pc.setMockStats(
			new Map([
				[
					'v-out',
					{ type: 'outbound-rtp', kind: 'video', bytesSent: 1000, packetsSent: 100 },
				],
				[
					'v-in',
					{
						type: 'remote-inbound-rtp',
						kind: 'video',
						packetsLost: 50,
						roundTripTime: 0.02,
					},
				],
			]),
		);

		const stats = await client.getStats();
		// 50 lost / (100 + 50) = 33% loss → poor
		expect(stats.quality).toBe('poor');
		expect(stats.roundTripTime).toBe(0.02);
	});
});

// ---------------------------------------------------------------------------
// Endpoint Recovery (RFC 9725 §4.3)
// ---------------------------------------------------------------------------

describe('WHIPClient – endpoint recovery', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('PATCHes the resource URL when endpointRecovery is enabled and server accepts', async () => {
		// POST returns 201 with ETag, recovery PATCH returns 200 with new answer
		vi.stubGlobal(
			'fetch',
			vi
				.fn()
				.mockResolvedValueOnce({
					status: 201,
					statusText: 'Created',
					text: () => Promise.resolve(MOCK_SDP_ANSWER),
					headers: new Headers({ Location: '/whip/resource/1', ETag: '"abc123"' }),
				})
				.mockResolvedValue({
					// PATCH (recovery) → success
					status: 200,
					statusText: 'OK',
					text: () => Promise.resolve(MOCK_SDP_ANSWER),
					headers: new Headers({ ETag: '"def456"' }),
				}),
		);

		const client = new WHIPClient({
			endpoint: 'https://example.com/whip',
			endpointRecovery: true,
			autoReconnect: false,
		});
		await client.publish(makeMockStream());
		await new Promise((r) => setTimeout(r, 10));

		// Manually invoke _doReconnect (internal, accessed for testing)
		await (client as unknown as { _doReconnect(): Promise<void> })._doReconnect();

		const fetchMock = vi.mocked(fetch) as ReturnType<typeof vi.fn>;
		const patchCall = fetchMock.mock.calls.find(
			([, init]) => (init as RequestInit).method === 'PATCH',
		);
		expect(patchCall).toBeDefined();

		// Should NOT have sent a DELETE before the PATCH
		const deleteBeforePatch = fetchMock.mock.calls
			.slice(0, fetchMock.mock.calls.indexOf(patchCall!))
			.find(([, init]) => (init as RequestInit).method === 'DELETE');
		expect(deleteBeforePatch).toBeUndefined();
	});

	it('sends If-Match header with ETag during recovery PATCH', async () => {
		vi.stubGlobal(
			'fetch',
			vi
				.fn()
				.mockResolvedValueOnce({
					status: 201,
					statusText: 'Created',
					text: () => Promise.resolve(MOCK_SDP_ANSWER),
					headers: new Headers({ Location: '/whip/resource/1', ETag: '"session-etag"' }),
				})
				.mockResolvedValue({
					status: 200,
					statusText: 'OK',
					text: () => Promise.resolve(MOCK_SDP_ANSWER),
					headers: new Headers({ ETag: '"new-etag"' }),
				}),
		);

		const client = new WHIPClient({
			endpoint: 'https://example.com/whip',
			endpointRecovery: true,
		});
		await client.publish(makeMockStream());
		await new Promise((r) => setTimeout(r, 10));
		await (client as unknown as { _doReconnect(): Promise<void> })._doReconnect();

		const fetchMock = vi.mocked(fetch) as ReturnType<typeof vi.fn>;
		const patchCall = fetchMock.mock.calls.find(
			([, init]) => (init as RequestInit).method === 'PATCH',
		);
		expect(patchCall).toBeDefined();
		const headers = (patchCall![1] as RequestInit).headers as Headers;
		expect(headers.get('If-Match')).toBe('"session-etag"');
	});

	it('falls back to full reconnect when recovery PATCH is rejected (404)', async () => {
		vi.stubGlobal(
			'fetch',
			vi
				.fn()
				// Initial POST
				.mockResolvedValueOnce({
					status: 201,
					statusText: 'Created',
					text: () => Promise.resolve(MOCK_SDP_ANSWER),
					headers: new Headers({ Location: '/whip/resource/1', ETag: '"stale"' }),
				})
				// Recovery PATCH fails
				.mockResolvedValueOnce({
					status: 404,
					statusText: 'Not Found',
					text: () => Promise.resolve('Session expired'),
					headers: new Headers(),
				})
				// Fallback DELETE
				.mockResolvedValueOnce({ status: 200, headers: new Headers() })
				// Fallback POST (full reconnect)
				.mockResolvedValueOnce({
					status: 201,
					statusText: 'Created',
					text: () => Promise.resolve(MOCK_SDP_ANSWER),
					headers: new Headers({ Location: '/whip/resource/2' }),
				}),
		);

		const client = new WHIPClient({
			endpoint: 'https://example.com/whip',
			endpointRecovery: true,
		});
		await client.publish(makeMockStream());
		await new Promise((r) => setTimeout(r, 10));
		await (client as unknown as { _doReconnect(): Promise<void> })._doReconnect();
		await new Promise((r) => setTimeout(r, 10));

		const fetchMock = vi.mocked(fetch) as ReturnType<typeof vi.fn>;
		// After fallback, a second POST should have been made
		const postCalls = fetchMock.mock.calls.filter(
			([, init]) => (init as RequestInit).method === 'POST',
		);
		expect(postCalls).toHaveLength(2);
	});

	it('does not attempt recovery when endpointRecovery is false (default)', async () => {
		vi.stubGlobal(
			'fetch',
			vi
				.fn()
				// Initial POST
				.mockResolvedValueOnce({
					status: 201,
					statusText: 'Created',
					text: () => Promise.resolve(MOCK_SDP_ANSWER),
					headers: new Headers({ Location: '/whip/resource/1', ETag: '"abc"' }),
				})
				// Fallback DELETE
				.mockResolvedValueOnce({ status: 200, headers: new Headers() })
				// Fallback POST (full reconnect)
				.mockResolvedValueOnce({
					status: 201,
					statusText: 'Created',
					text: () => Promise.resolve(MOCK_SDP_ANSWER),
					headers: new Headers({ Location: '/whip/resource/2' }),
				}),
		);

		const client = new WHIPClient({ endpoint: 'https://example.com/whip' });
		await client.publish(makeMockStream());
		await new Promise((r) => setTimeout(r, 10));
		await (client as unknown as { _doReconnect(): Promise<void> })._doReconnect();
		await new Promise((r) => setTimeout(r, 10));

		const fetchMock = vi.mocked(fetch) as ReturnType<typeof vi.fn>;
		// Should never have sent a PATCH for recovery
		const patchCall = fetchMock.mock.calls.find(
			([, init]) => (init as RequestInit).method === 'PATCH',
		);
		expect(patchCall).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Adaptive quality
// ---------------------------------------------------------------------------

describe('WHIPClient – adaptive quality', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	function mockFetchForAdaptive() {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue({
				status: 201,
				statusText: 'Created',
				text: () => Promise.resolve(MOCK_SDP_ANSWER),
				headers: new Headers({ Location: '/whip/resource/1' }),
			}),
		);
	}

	function makeStatsResult(quality: StreamStats['quality']): StreamStats {
		return {
			timestamp: Date.now(),
			audio: null,
			video: {
				bitrate: 1_000_000,
				packetsLost: 0,
				packetsLostRate: 0,
				frameRate: 30,
				width: 1280,
				height: 720,
			},
			roundTripTime: 0.02,
			quality,
		};
	}

	it('emits qualitychange and reduces bitrate after downgradeThreshold consecutive poor readings', async () => {
		mockFetchForAdaptive();

		const client = new WHIPClient({
			endpoint: 'https://example.com/whip',
			video: { maxBitrate: 2_000_000 },
			adaptiveQuality: { intervalMs: 1000, downgradeThreshold: 2, upgradeThreshold: 4 },
		});
		// Start publish without awaiting, then flush the setTimeout(0) that simulates ICE connection
		const pp = client.publish(makeMockStream());
		await vi.advanceTimersByTimeAsync(0);
		await pp;

		const statsSpy = vi.spyOn(client, 'getStats').mockResolvedValue(makeStatsResult('poor'));

		const onChange = vi.fn();
		client.on('qualitychange', onChange);

		// First poor reading: threshold not reached
		await vi.advanceTimersByTimeAsync(1000);
		expect(onChange).not.toHaveBeenCalled();

		// Second poor reading: threshold reached → downgrade
		await vi.advanceTimersByTimeAsync(1000);
		expect(onChange).toHaveBeenCalledOnce();
		expect(onChange).toHaveBeenCalledWith('poor');

		statsSpy.mockRestore();
		await client.stop();
	});

	it('emits qualitychange and restores bitrate after upgradeThreshold consecutive improved readings', async () => {
		mockFetchForAdaptive();

		const client = new WHIPClient({
			endpoint: 'https://example.com/whip',
			video: { maxBitrate: 2_000_000 },
			adaptiveQuality: { intervalMs: 1000, downgradeThreshold: 2, upgradeThreshold: 3 },
		});
		const pp = client.publish(makeMockStream());
		await vi.advanceTimersByTimeAsync(0);
		await pp;

		const statsSpy = vi.spyOn(client, 'getStats').mockResolvedValue(makeStatsResult('poor'));

		const onChange = vi.fn();
		client.on('qualitychange', onChange);

		// Downgrade first (2 consecutive poor readings)
		await vi.advanceTimersByTimeAsync(2000);
		expect(onChange).toHaveBeenLastCalledWith('poor');

		// Now simulate quality recovery
		statsSpy.mockResolvedValue(makeStatsResult('excellent'));

		// upgradeThreshold = 3 → need 3 excellent readings
		await vi.advanceTimersByTimeAsync(2000);
		expect(onChange).toHaveBeenCalledTimes(1); // not yet

		await vi.advanceTimersByTimeAsync(1000);
		expect(onChange).toHaveBeenCalledTimes(2);
		expect(onChange).toHaveBeenLastCalledWith('excellent');

		statsSpy.mockRestore();
		await client.stop();
	});

	it('applies the correct bitrate fraction to the video sender', async () => {
		mockFetchForAdaptive();

		const client = new WHIPClient({
			endpoint: 'https://example.com/whip',
			video: { maxBitrate: 2_000_000 },
			adaptiveQuality: { intervalMs: 1000, downgradeThreshold: 1, upgradeThreshold: 4 },
		});
		const pp = client.publish(makeMockStream());
		await vi.advanceTimersByTimeAsync(0);
		await pp;

		const statsSpy = vi.spyOn(client, 'getStats').mockResolvedValue(makeStatsResult('fair'));

		const pc = (client as unknown as { pc: MockRTCPeerConnection }).pc!;
		const videoSender = pc
			.getSenders()
			.find(
				(s) => s instanceof MockRTCRtpSender && s.track?.kind === 'video',
			) as MockRTCRtpSender;
		const setParamsSpy = vi.spyOn(videoSender, 'setParameters');

		// downgradeThreshold = 1 → triggers on first fair reading
		await vi.advanceTimersByTimeAsync(1000);

		expect(setParamsSpy).toHaveBeenCalled();
		const params = setParamsSpy.mock.calls[0]![0] as RTCRtpSendParameters;
		// fair → 50% of 2_000_000 = 1_000_000
		expect(params.encodings[0]!.maxBitrate).toBe(1_000_000);

		statsSpy.mockRestore();
		await client.stop();
	});

	it('does not start adaptive quality polling when adaptiveQuality is false', async () => {
		mockFetchForAdaptive();

		const client = new WHIPClient({ endpoint: 'https://example.com/whip' });
		const pp = client.publish(makeMockStream());
		await vi.advanceTimersByTimeAsync(0);
		await pp;

		const statsSpy = vi.spyOn(client, 'getStats');
		const onChange = vi.fn();
		client.on('qualitychange', onChange);

		await vi.advanceTimersByTimeAsync(10_000);

		expect(statsSpy).not.toHaveBeenCalled();
		expect(onChange).not.toHaveBeenCalled();

		await client.stop();
	});

	it('stops adaptive quality polling after stop()', async () => {
		mockFetchForAdaptive();

		const client = new WHIPClient({
			endpoint: 'https://example.com/whip',
			adaptiveQuality: { intervalMs: 1000 },
		});
		const pp = client.publish(makeMockStream());
		await vi.advanceTimersByTimeAsync(0);
		await pp;

		const statsSpy = vi.spyOn(client, 'getStats').mockResolvedValue(makeStatsResult('poor'));
		await client.stop();

		const callsBefore = statsSpy.mock.calls.length;
		await vi.advanceTimersByTimeAsync(5000);
		// No new calls after stop()
		expect(statsSpy.mock.calls.length).toBe(callsBefore);
	});

	it('respects minVideoBitrate floor', async () => {
		mockFetchForAdaptive();

		const client = new WHIPClient({
			endpoint: 'https://example.com/whip',
			video: { maxBitrate: 200_000 },
			adaptiveQuality: {
				intervalMs: 1000,
				downgradeThreshold: 1,
				minVideoBitrate: 160_000,
			},
		});
		const pp = client.publish(makeMockStream());
		await vi.advanceTimersByTimeAsync(0);
		await pp;

		const statsSpy = vi.spyOn(client, 'getStats').mockResolvedValue(makeStatsResult('poor'));

		const pc = (client as unknown as { pc: MockRTCPeerConnection }).pc!;
		const videoSender = pc
			.getSenders()
			.find(
				(s) => s instanceof MockRTCRtpSender && s.track?.kind === 'video',
			) as MockRTCRtpSender;
		const setParamsSpy = vi.spyOn(videoSender, 'setParameters');

		await vi.advanceTimersByTimeAsync(1000);

		const params = setParamsSpy.mock.calls[0]![0] as RTCRtpSendParameters;
		// poor → 25% of 200_000 = 50_000, but floor is 160_000
		expect(params.encodings[0]!.maxBitrate).toBe(160_000);

		statsSpy.mockRestore();
		await client.stop();
	});
});

// ---------------------------------------------------------------------------
// muteTrack / unmuteTrack / isTrackMuted
// ---------------------------------------------------------------------------

describe('WHIPClient – muteTrack / unmuteTrack / isTrackMuted', () => {
	beforeEach(() => {
		vi.stubGlobal('fetch', mockFetchSuccess());
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('muteTrack("audio") disables the audio sender track', async () => {
		const client = new WHIPClient({ endpoint: 'https://example.com/whip' });
		await client.publish(makeMockStream());

		client.muteTrack('audio');

		const pc = (client as unknown as { pc: MockRTCPeerConnection }).pc!;
		const sender = pc
			.getSenders()
			.find(
				(s) => s instanceof MockRTCRtpSender && s.track?.kind === 'audio',
			) as MockRTCRtpSender;
		expect(sender.track!.enabled).toBe(false);
	});

	it('muteTrack("video") disables the video sender track', async () => {
		const client = new WHIPClient({ endpoint: 'https://example.com/whip' });
		await client.publish(makeMockStream());

		client.muteTrack('video');

		const pc = (client as unknown as { pc: MockRTCPeerConnection }).pc!;
		const sender = pc
			.getSenders()
			.find(
				(s) => s instanceof MockRTCRtpSender && s.track?.kind === 'video',
			) as MockRTCRtpSender;
		expect(sender.track!.enabled).toBe(false);
	});

	it('unmuteTrack re-enables a muted track', async () => {
		const client = new WHIPClient({ endpoint: 'https://example.com/whip' });
		await client.publish(makeMockStream());

		client.muteTrack('audio');
		client.unmuteTrack('audio');

		const pc = (client as unknown as { pc: MockRTCPeerConnection }).pc!;
		const sender = pc
			.getSenders()
			.find(
				(s) => s instanceof MockRTCRtpSender && s.track?.kind === 'audio',
			) as MockRTCRtpSender;
		expect(sender.track!.enabled).toBe(true);
	});

	it('isTrackMuted returns false for an active track', async () => {
		const client = new WHIPClient({ endpoint: 'https://example.com/whip' });
		await client.publish(makeMockStream());

		expect(client.isTrackMuted('audio')).toBe(false);
	});

	it('isTrackMuted returns true after muteTrack', async () => {
		const client = new WHIPClient({ endpoint: 'https://example.com/whip' });
		await client.publish(makeMockStream());

		client.muteTrack('audio');
		expect(client.isTrackMuted('audio')).toBe(true);
	});

	it('isTrackMuted returns false again after unmuteTrack', async () => {
		const client = new WHIPClient({ endpoint: 'https://example.com/whip' });
		await client.publish(makeMockStream());

		client.muteTrack('video');
		client.unmuteTrack('video');
		expect(client.isTrackMuted('video')).toBe(false);
	});

	it('muteTrack throws InvalidStateError when no active peer connection', () => {
		const client = new WHIPClient({ endpoint: 'https://example.com/whip' });
		expect(() => client.muteTrack('audio')).toThrow(InvalidStateError);
	});

	it('unmuteTrack throws InvalidStateError when no active peer connection', () => {
		const client = new WHIPClient({ endpoint: 'https://example.com/whip' });
		expect(() => client.unmuteTrack('audio')).toThrow(InvalidStateError);
	});

	it('isTrackMuted throws InvalidStateError when no active peer connection', () => {
		const client = new WHIPClient({ endpoint: 'https://example.com/whip' });
		expect(() => client.isTrackMuted('audio')).toThrow(InvalidStateError);
	});

	it('muteTrack throws InvalidStateError when no sender for the given kind', async () => {
		const client = new WHIPClient({ endpoint: 'https://example.com/whip' });
		// Audio-only stream → no video sender
		await client.publish(makeMockStream(['audio']));

		expect(() => client.muteTrack('video')).toThrow(InvalidStateError);
	});
});

// ---------------------------------------------------------------------------
// publishScreen()
// ---------------------------------------------------------------------------

describe('WHIPClient – publishScreen', () => {
	let mockVideoTrack: MediaStreamTrack;
	let mockDisplayStream: MediaStream;
	let getDisplayMediaMock: ReturnType<typeof vi.fn>;

	function stubMediaDevices(
		overrides: Partial<{ getDisplayMedia: unknown; getUserMedia: unknown }> = {},
	) {
		Object.defineProperty(global, 'navigator', {
			value: {
				mediaDevices: {
					getDisplayMedia: getDisplayMediaMock,
					getUserMedia: vi.fn().mockResolvedValue(new MediaStream()),
					...overrides,
				},
			},
			writable: true,
			configurable: true,
		});
	}

	beforeEach(() => {
		vi.stubGlobal('fetch', mockFetchSuccess());

		mockVideoTrack = {
			kind: 'video',
			stop: vi.fn(),
			id: 'screen-video',
			contentHint: '',
			enabled: true,
		} as unknown as MediaStreamTrack;

		mockDisplayStream = new MediaStream();
		mockDisplayStream.addTrack(mockVideoTrack);

		getDisplayMediaMock = vi.fn().mockResolvedValue(mockDisplayStream);
		stubMediaDevices();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('calls getDisplayMedia and publishes the screen stream', async () => {
		const client = new WHIPClient({ endpoint: 'https://example.com/whip' });

		await client.publishScreen();

		expect(getDisplayMediaMock).toHaveBeenCalledOnce();
	});

	it('returns a MediaStream containing the screen video track', async () => {
		const client = new WHIPClient({ endpoint: 'https://example.com/whip' });

		const stream = await client.publishScreen();

		expect(stream.getVideoTracks()).toHaveLength(1);
		expect(stream.getVideoTracks()[0]!.id).toBe('screen-video');
	});

	it('does not include audio when neither micAudio nor displayAudio is set', async () => {
		const client = new WHIPClient({ endpoint: 'https://example.com/whip' });

		const stream = await client.publishScreen();

		expect(stream.getAudioTracks()).toHaveLength(0);
	});

	it('requests microphone audio when micAudio is true', async () => {
		const mockMicTrack = {
			kind: 'audio',
			stop: vi.fn(),
			id: 'mic-audio',
			enabled: true,
		} as unknown as MediaStreamTrack;
		const mockMicStream = new MediaStream();
		mockMicStream.addTrack(mockMicTrack);

		const getUserMediaMock = vi.fn().mockResolvedValue(mockMicStream);
		stubMediaDevices({ getUserMedia: getUserMediaMock });

		const client = new WHIPClient({ endpoint: 'https://example.com/whip' });
		const stream = await client.publishScreen({ micAudio: true });

		expect(getUserMediaMock).toHaveBeenCalledWith(
			expect.objectContaining({ audio: true, video: false }),
		);
		expect(stream.getAudioTracks()).toHaveLength(1);
		expect(stream.getAudioTracks()[0]!.id).toBe('mic-audio');
	});

	it('forwards MediaTrackConstraints to getUserMedia when micAudio is an object', async () => {
		const mockMicStream = new MediaStream();
		mockMicStream.addTrack({
			kind: 'audio',
			stop: vi.fn(),
			id: 'mic-constrained',
			enabled: true,
		} as unknown as MediaStreamTrack);

		const getUserMediaMock = vi.fn().mockResolvedValue(mockMicStream);
		stubMediaDevices({ getUserMedia: getUserMediaMock });

		const client = new WHIPClient({ endpoint: 'https://example.com/whip' });
		await client.publishScreen({ micAudio: { echoCancellation: true } });

		expect(getUserMediaMock).toHaveBeenCalledWith(
			expect.objectContaining({ audio: { echoCancellation: true } }),
		);
	});

	it('uses display audio track when displayAudio is true', async () => {
		const mockAudioTrack = {
			kind: 'audio',
			stop: vi.fn(),
			id: 'display-audio',
			enabled: true,
		} as unknown as MediaStreamTrack;
		mockDisplayStream.addTrack(mockAudioTrack);

		const client = new WHIPClient({ endpoint: 'https://example.com/whip' });
		const stream = await client.publishScreen({ displayAudio: true });

		expect(stream.getAudioTracks()).toHaveLength(1);
		expect(stream.getAudioTracks()[0]!.id).toBe('display-audio');
	});

	it('micAudio takes precedence over displayAudio', async () => {
		const mockDisplayAudioTrack = {
			kind: 'audio',
			stop: vi.fn(),
			id: 'display-audio',
			enabled: true,
		} as unknown as MediaStreamTrack;
		mockDisplayStream.addTrack(mockDisplayAudioTrack);

		const mockMicTrack = {
			kind: 'audio',
			stop: vi.fn(),
			id: 'mic-audio',
			enabled: true,
		} as unknown as MediaStreamTrack;
		const mockMicStream = new MediaStream();
		mockMicStream.addTrack(mockMicTrack);
		stubMediaDevices({ getUserMedia: vi.fn().mockResolvedValue(mockMicStream) });

		const client = new WHIPClient({ endpoint: 'https://example.com/whip' });
		const stream = await client.publishScreen({ displayAudio: true, micAudio: true });

		// Should use mic audio, not display audio
		expect(stream.getAudioTracks()[0]!.id).toBe('mic-audio');
	});

	it('stops display stream tracks when getUserMedia fails', async () => {
		stubMediaDevices({
			getUserMedia: vi
				.fn()
				.mockRejectedValue(new DOMException('Permission denied', 'NotAllowedError')),
		});

		const client = new WHIPClient({ endpoint: 'https://example.com/whip' });

		await expect(client.publishScreen({ micAudio: true })).rejects.toThrow();
		expect(mockVideoTrack.stop).toHaveBeenCalled();
	});

	it('stops all captured tracks when publish fails after screen capture', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue({
				status: 500,
				statusText: 'Internal Server Error',
				text: () => Promise.resolve('Server error'),
				headers: new Headers(),
			}),
		);

		const client = new WHIPClient({ endpoint: 'https://example.com/whip' });

		await expect(client.publishScreen()).rejects.toThrow();
		expect(mockVideoTrack.stop).toHaveBeenCalled();
	});

	it('throws InvalidStateError when not in idle state', async () => {
		vi.stubGlobal('fetch', mockFetchSuccess());
		const client = new WHIPClient({ endpoint: 'https://example.com/whip' });
		await client.publish(makeMockStream());

		await expect(client.publishScreen()).rejects.toThrow(InvalidStateError);
	});

	it('transitions to connected state after publishScreen', async () => {
		const client = new WHIPClient({ endpoint: 'https://example.com/whip' });
		await client.publishScreen();

		await new Promise((r) => setTimeout(r, 10));
		expect(client.state).toBe('connected');
	});
});

// ---------------------------------------------------------------------------
// watchStats()
// ---------------------------------------------------------------------------

describe('WHIPClient – watchStats', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.stubGlobal('fetch', mockFetchSuccess());
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('invokes the callback at the given interval', async () => {
		const client = new WHIPClient({ endpoint: 'https://example.com/whip' });
		const pp = client.publish(makeMockStream());
		await vi.advanceTimersByTimeAsync(0);
		await pp;

		const mockStats: StreamStats = {
			timestamp: Date.now(),
			audio: null,
			video: null,
			roundTripTime: null,
			quality: 'excellent',
		};
		vi.spyOn(client, 'getStats').mockResolvedValue(mockStats);

		const callback = vi.fn();
		client.watchStats(1_000, callback);

		await vi.advanceTimersByTimeAsync(1_000);
		expect(callback).toHaveBeenCalledOnce();
		expect(callback).toHaveBeenCalledWith(
			mockStats,
			expect.objectContaining({ snapshots: [mockStats] }),
		);

		await vi.advanceTimersByTimeAsync(1_000);
		expect(callback).toHaveBeenCalledTimes(2);

		await client.stop();
	});

	it('returned cleanup function stops polling', async () => {
		const client = new WHIPClient({ endpoint: 'https://example.com/whip' });
		const pp = client.publish(makeMockStream());
		await vi.advanceTimersByTimeAsync(0);
		await pp;

		vi.spyOn(client, 'getStats').mockResolvedValue({
			timestamp: Date.now(),
			audio: null,
			video: null,
			roundTripTime: null,
			quality: 'excellent',
		});

		const callback = vi.fn();
		const stop = client.watchStats(1_000, callback);

		await vi.advanceTimersByTimeAsync(1_000);
		expect(callback).toHaveBeenCalledOnce();

		stop();

		await vi.advanceTimersByTimeAsync(3_000);
		// No additional calls after cleanup
		expect(callback).toHaveBeenCalledOnce();

		await client.stop();
	});

	it('silently ignores getStats errors so polling continues', async () => {
		const client = new WHIPClient({ endpoint: 'https://example.com/whip' });
		const pp = client.publish(makeMockStream());
		await vi.advanceTimersByTimeAsync(0);
		await pp;

		const statsSpy = vi
			.spyOn(client, 'getStats')
			.mockRejectedValueOnce(new Error('Transient error'))
			.mockResolvedValue({
				timestamp: Date.now(),
				audio: null,
				video: null,
				roundTripTime: null,
				quality: 'good',
			});

		const callback = vi.fn();
		client.watchStats(1_000, callback);

		// First tick throws — callback not called
		await vi.advanceTimersByTimeAsync(1_000);
		expect(callback).not.toHaveBeenCalled();

		// Second tick succeeds
		await vi.advanceTimersByTimeAsync(1_000);
		expect(callback).toHaveBeenCalledOnce();

		statsSpy.mockRestore();
		await client.stop();
	});
});

// ---------------------------------------------------------------------------
// startAudioLevelMonitor / stopAudioLevelMonitor
// ---------------------------------------------------------------------------

describe('WHIPClient – audio level monitor', () => {
	type MockAnalyser = {
		frequencyBinCount: number;
		getFloatTimeDomainData: ReturnType<typeof vi.fn>;
		connect: ReturnType<typeof vi.fn>;
	};
	type MockAudioCtx = {
		createAnalyser: ReturnType<typeof vi.fn>;
		createMediaStreamSource: ReturnType<typeof vi.fn>;
		close: ReturnType<typeof vi.fn>;
	};

	let mockAnalyser: MockAnalyser;
	let mockAudioCtx: MockAudioCtx;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.stubGlobal('fetch', mockFetchSuccess());

		mockAnalyser = {
			frequencyBinCount: 4,
			getFloatTimeDomainData: vi.fn((buf: Float32Array) => buf.fill(0.5)),
			connect: vi.fn(),
		};
		mockAudioCtx = {
			createAnalyser: vi.fn(() => mockAnalyser),
			createMediaStreamSource: vi.fn(() => ({ connect: vi.fn() })),
			close: vi.fn().mockResolvedValue(undefined),
		};
		vi.stubGlobal(
			'AudioContext',
			vi.fn(() => mockAudioCtx),
		);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('throws InvalidStateError when called before publish()', () => {
		const client = new WHIPClient({ endpoint: 'https://example.com/whip' });
		expect(() => client.startAudioLevelMonitor()).toThrow(InvalidStateError);
	});

	it('throws InvalidStateError when no audio sender exists', async () => {
		const client = new WHIPClient({ endpoint: 'https://example.com/whip' });
		const pp = client.publish(makeMockStream(['video']));
		await vi.advanceTimersByTimeAsync(0);
		await pp;

		expect(() => client.startAudioLevelMonitor()).toThrow(InvalidStateError);
	});

	it('emits audiolevel events at the given interval', async () => {
		const client = new WHIPClient({ endpoint: 'https://example.com/whip' });
		const pp = client.publish(makeMockStream());
		await vi.advanceTimersByTimeAsync(0);
		await pp;

		const onLevel = vi.fn();
		client.on('audiolevel', onLevel);
		client.startAudioLevelMonitor(100);

		await vi.advanceTimersByTimeAsync(100);
		expect(onLevel).toHaveBeenCalledOnce();

		await vi.advanceTimersByTimeAsync(200);
		expect(onLevel).toHaveBeenCalledTimes(3);

		await client.stop();
	});

	it('emitted level is a number in [0, 1]', async () => {
		const client = new WHIPClient({ endpoint: 'https://example.com/whip' });
		const pp = client.publish(makeMockStream());
		await vi.advanceTimersByTimeAsync(0);
		await pp;

		const levels: number[] = [];
		client.on('audiolevel', (l) => levels.push(l));
		client.startAudioLevelMonitor(100);

		await vi.advanceTimersByTimeAsync(100);

		expect(levels).toHaveLength(1);
		expect(levels[0]).toBeGreaterThanOrEqual(0);
		expect(levels[0]).toBeLessThanOrEqual(1);

		await client.stop();
	});

	it('emitted level matches the RMS of the analyser buffer (0.5 filled → ~0.5)', async () => {
		// buf.fill(0.5) → RMS = sqrt(sum(0.25 * 4) / 4) = sqrt(0.25) = 0.5
		const client = new WHIPClient({ endpoint: 'https://example.com/whip' });
		const pp = client.publish(makeMockStream());
		await vi.advanceTimersByTimeAsync(0);
		await pp;

		const levels: number[] = [];
		client.on('audiolevel', (l) => levels.push(l));
		client.startAudioLevelMonitor(100);
		await vi.advanceTimersByTimeAsync(100);

		expect(levels[0]).toBeCloseTo(0.5, 5);

		await client.stop();
	});

	it('stopAudioLevelMonitor stops the polling', async () => {
		const client = new WHIPClient({ endpoint: 'https://example.com/whip' });
		const pp = client.publish(makeMockStream());
		await vi.advanceTimersByTimeAsync(0);
		await pp;

		const onLevel = vi.fn();
		client.on('audiolevel', onLevel);
		client.startAudioLevelMonitor(100);

		await vi.advanceTimersByTimeAsync(100);
		expect(onLevel).toHaveBeenCalledOnce();

		client.stopAudioLevelMonitor();

		await vi.advanceTimersByTimeAsync(500);
		// No additional events after stop
		expect(onLevel).toHaveBeenCalledOnce();

		await client.stop();
	});

	it('stopAudioLevelMonitor closes the AudioContext', async () => {
		const client = new WHIPClient({ endpoint: 'https://example.com/whip' });
		const pp = client.publish(makeMockStream());
		await vi.advanceTimersByTimeAsync(0);
		await pp;

		client.startAudioLevelMonitor(100);
		client.stopAudioLevelMonitor();

		expect(mockAudioCtx.close).toHaveBeenCalledOnce();

		await client.stop();
	});

	it('stop() automatically stops the audio level monitor', async () => {
		const client = new WHIPClient({ endpoint: 'https://example.com/whip' });
		const pp = client.publish(makeMockStream());
		await vi.advanceTimersByTimeAsync(0);
		await pp;

		const onLevel = vi.fn();
		client.on('audiolevel', onLevel);
		client.startAudioLevelMonitor(100);

		await vi.advanceTimersByTimeAsync(100);
		expect(onLevel).toHaveBeenCalledOnce();

		await client.stop();

		await vi.advanceTimersByTimeAsync(500);
		expect(onLevel).toHaveBeenCalledOnce();
		expect(mockAudioCtx.close).toHaveBeenCalled();
	});

	it('calling startAudioLevelMonitor twice replaces the previous monitor', async () => {
		const client = new WHIPClient({ endpoint: 'https://example.com/whip' });
		const pp = client.publish(makeMockStream());
		await vi.advanceTimersByTimeAsync(0);
		await pp;

		client.startAudioLevelMonitor(100);
		// Second call should close the first AudioContext and start fresh
		client.startAudioLevelMonitor(200);

		expect(mockAudioCtx.close).toHaveBeenCalledOnce();

		await client.stop();
	});
});

// ---------------------------------------------------------------------------
// AbortSignal support in publish()
// ---------------------------------------------------------------------------

describe('WHIPClient – AbortSignal in publish()', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('throws DOMException AbortError when signal is already aborted', async () => {
		vi.stubGlobal('fetch', mockFetchSuccess());

		const client = new WHIPClient({ endpoint: 'https://example.com/whip' });
		const ac = new AbortController();
		ac.abort();

		await expect(client.publish(makeMockStream(), { signal: ac.signal })).rejects.toMatchObject(
			{
				name: 'AbortError',
			},
		);
	});

	it('transitions to closed state when signal is pre-aborted', async () => {
		vi.stubGlobal('fetch', mockFetchSuccess());

		const client = new WHIPClient({ endpoint: 'https://example.com/whip' });
		const ac = new AbortController();
		ac.abort();

		await expect(client.publish(makeMockStream(), { signal: ac.signal })).rejects.toThrow();
		expect(client.state).toBe('closed');
	});

	it('aborts the in-flight fetch when signal fires during POST', async () => {
		// Simulate a real fetch that rejects when its AbortSignal fires
		vi.stubGlobal(
			'fetch',
			vi.fn().mockImplementation((_url: string, init: RequestInit) => {
				return new Promise((_, reject) => {
					const signal = init.signal;
					if (signal?.aborted) {
						reject(new DOMException('Aborted', 'AbortError'));
						return;
					}
					signal?.addEventListener('abort', () => {
						reject(new DOMException('Aborted', 'AbortError'));
					});
				});
			}),
		);

		const client = new WHIPClient({ endpoint: 'https://example.com/whip' });
		const ac = new AbortController();

		const publishPromise = client.publish(makeMockStream(), { signal: ac.signal });

		// Abort while fetch is in-flight — the mock fetch rejects via the signal listener
		ac.abort();

		await expect(publishPromise).rejects.toMatchObject({ name: 'AbortError' });
	});

	it('does not emit connected when aborted before ICE finishes', async () => {
		vi.stubGlobal('fetch', mockFetchSuccess());

		const client = new WHIPClient({ endpoint: 'https://example.com/whip' });
		const onConnected = vi.fn();
		client.on('connected', onConnected);

		const ac = new AbortController();
		ac.abort();

		await expect(client.publish(makeMockStream(), { signal: ac.signal })).rejects.toThrow();
		await new Promise((r) => setTimeout(r, 10));

		expect(onConnected).not.toHaveBeenCalled();
	});
});
