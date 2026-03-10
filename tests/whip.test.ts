import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WHIPClient } from '../src/whip/WHIPClient.js';
import { WHIPError, InvalidStateError } from '../src/core/errors.js';
import type { MockRTCPeerConnection } from './setup.js';
import { MOCK_SDP_ANSWER } from './setup.js';

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
});
