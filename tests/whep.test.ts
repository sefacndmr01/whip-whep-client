import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WHEPClient } from '../src/whep/WHEPClient.js';
import { WHEPError, InvalidStateError } from '../src/core/errors.js';
import type { MockRTCPeerConnection } from './setup.js';
import { MOCK_SDP_ANSWER } from './setup.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockFetchSuccess(location = '/whep/resource/1') {
	return vi.fn().mockResolvedValue({
		status: 201,
		statusText: 'Created',
		text: () => Promise.resolve(MOCK_SDP_ANSWER),
		headers: new Headers({ Location: location }),
	});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WHEPClient', () => {
	beforeEach(() => {
		vi.stubGlobal('fetch', mockFetchSuccess());
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	// ---- Constructor ---------------------------------------------------------

	it('starts in idle state', () => {
		const client = new WHEPClient({ endpoint: 'https://example.com/whep' });
		expect(client.state).toBe('idle');
		expect(client.resource).toBeNull();
	});

	// ---- view() --------------------------------------------------------------

	it('returns a MediaStream', async () => {
		const client = new WHEPClient({ endpoint: 'https://example.com/whep' });
		const stream = await client.view();
		expect(stream).toBeInstanceOf(MediaStream);
	});

	it('sets resource URL from Location header', async () => {
		const client = new WHEPClient({ endpoint: 'https://example.com/whep' });
		await client.view();
		expect(client.resource).toBe('https://example.com/whep/resource/1');
	});

	it('sends Authorization header when token provided', async () => {
		const fetchSpy = mockFetchSuccess();
		vi.stubGlobal('fetch', fetchSpy);

		const client = new WHEPClient({
			endpoint: 'https://example.com/whep',
			token: 'viewer-token',
		});

		await client.view();

		const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
		const headers = init.headers as Headers;
		expect(headers.get('Authorization')).toBe('Bearer viewer-token');
	});

	it('POSTs SDP offer with recvonly direction', async () => {
		const fetchSpy = mockFetchSuccess();
		vi.stubGlobal('fetch', fetchSpy);

		const client = new WHEPClient({ endpoint: 'https://example.com/whep' });
		await client.view();

		expect(fetchSpy).toHaveBeenCalledWith(
			'https://example.com/whep',
			expect.objectContaining({ method: 'POST' }),
		);
	});

	it('emits stream event when tracks arrive', async () => {
		const client = new WHEPClient({ endpoint: 'https://example.com/whep' });
		const onStream = vi.fn();
		client.on('stream', onStream);

		await client.view();

		// Simulate tracks arriving via the mock PC
		const pc = (client as unknown as { pc: MockRTCPeerConnection }).pc!;
		pc.simulateTrack('audio');
		pc.simulateTrack('video');

		expect(onStream).toHaveBeenCalledOnce();
		expect(onStream.mock.calls[0]?.[0]).toBeInstanceOf(MediaStream);
	});

	it('emits stream event after first track when video=false', async () => {
		const client = new WHEPClient({ endpoint: 'https://example.com/whep' });
		const onStream = vi.fn();
		client.on('stream', onStream);

		await client.view({ video: false });

		const pc = (client as unknown as { pc: MockRTCPeerConnection }).pc!;
		pc.simulateTrack('audio');

		expect(onStream).toHaveBeenCalledOnce();
	});

	it('emits connected event on connection state change', async () => {
		const client = new WHEPClient({ endpoint: 'https://example.com/whep' });
		const onConnected = vi.fn();
		client.on('connected', onConnected);

		await client.view();
		await new Promise((r) => setTimeout(r, 10));

		expect(onConnected).toHaveBeenCalledOnce();
	});

	it('throws WHEPError when server returns non-201', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue({
				status: 404,
				statusText: 'Not Found',
				text: () => Promise.resolve('Stream not found'),
				headers: new Headers(),
			}),
		);

		const client = new WHEPClient({ endpoint: 'https://example.com/whep' });
		await expect(client.view()).rejects.toThrow(WHEPError);
	});

	it('throws InvalidStateError when view() called twice', async () => {
		const client = new WHEPClient({ endpoint: 'https://example.com/whep' });
		await client.view();

		await expect(client.view()).rejects.toThrow(InvalidStateError);
	});

	it('applies video codec preference to SDP offer', async () => {
		const fetchSpy = mockFetchSuccess();
		vi.stubGlobal('fetch', fetchSpy);

		const client = new WHEPClient({
			endpoint: 'https://example.com/whep',
			videoCodec: 'H264',
		});

		await client.view();

		const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
		const body = init.body as string;
		const videoMLine = body.split('\r\n').find((l: string) => l.startsWith('m=video'));
		expect(videoMLine).toMatch(/^m=video \S+ \S+ 98/);
	});

	// ---- stop() --------------------------------------------------------------

	it('sends DELETE request on stop()', async () => {
		const fetchSpy = vi
			.fn()
			.mockResolvedValueOnce({
				status: 201,
				statusText: 'Created',
				text: () => Promise.resolve(MOCK_SDP_ANSWER),
				headers: new Headers({ Location: '/whep/resource/1' }),
			})
			.mockResolvedValueOnce({ status: 200, headers: new Headers() });

		vi.stubGlobal('fetch', fetchSpy);

		const client = new WHEPClient({ endpoint: 'https://example.com/whep' });
		await client.view();
		await client.stop();

		const calls = fetchSpy.mock.calls as Array<[string, RequestInit]>;
		const deleteCall = calls.find(([, init]) => init.method === 'DELETE');
		expect(deleteCall).toBeDefined();
	});

	it('transitions to closed state after stop()', async () => {
		const client = new WHEPClient({ endpoint: 'https://example.com/whep' });
		await client.view();
		await client.stop();

		expect(client.state).toBe('closed');
		expect(client.resource).toBeNull();
	});

	it('stop() is safe to call multiple times', async () => {
		const client = new WHEPClient({ endpoint: 'https://example.com/whep' });
		await client.view();
		await client.stop();
		await expect(client.stop()).resolves.toBeUndefined();
	});
});
