import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WHIPClient } from '../src/whip/WHIPClient.js';
import { WHIPError, InvalidStateError } from '../src/core/errors.js';
import type { MockRTCPeerConnection } from './setup.js';
import { MOCK_SDP_ANSWER, MockRTCRtpSender } from './setup.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockStream(kinds: Array<'audio' | 'video'> = ['audio', 'video']): MediaStream {
	const tracks = kinds.map((kind) => ({
		kind,
		stop: vi.fn(),
		id: `mock-${kind}`,
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
