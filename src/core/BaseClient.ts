import type {
	BaseClientOptions,
	BaseClientEvents,
	EventMap,
	Logger,
	AutoReconnectOptions,
} from './types.js';
import { WhipWhepError, TimeoutError, InvalidStateError } from './errors.js';

// ---------------------------------------------------------------------------
// TypedEventEmitter
// ---------------------------------------------------------------------------

/**
 * Strongly-typed event emitter.
 *
 * Provides `on`, `off`, `once`, and `emit` with full TypeScript inference
 * over a generic event map.
 *
 * Internal storage is untyped (`unknown`) to avoid the variance conflicts
 * that arise when trying to make the listener Set generic. All type safety
 * is enforced at the public API boundary.
 */
export class TypedEventEmitter<TEvents extends EventMap> {
	private readonly _listeners = new Map<keyof TEvents, Set<EventMap[string]>>();

	on<K extends keyof TEvents>(event: K, listener: TEvents[K]): this {
		let set = this._listeners.get(event);
		if (!set) {
			set = new Set();
			this._listeners.set(event, set);
		}
		set.add(listener);
		return this;
	}

	off<K extends keyof TEvents>(event: K, listener: TEvents[K]): this {
		this._listeners.get(event)?.delete(listener);
		return this;
	}

	once<K extends keyof TEvents>(event: K, listener: TEvents[K]): this {
		const wrapper = (...args: Parameters<TEvents[K]>) => {
			this.off(event, wrapper as unknown as TEvents[K]);
			(listener as (...a: Parameters<TEvents[K]>) => void)(...args);
		};
		return this.on(event, wrapper as unknown as TEvents[K]);
	}

	protected emit<K extends keyof TEvents>(event: K, ...args: Parameters<TEvents[K]>): void {
		this._listeners
			.get(event)
			?.forEach((fn) => (fn as (...a: Parameters<TEvents[K]>) => void)(...args));
	}

	removeAllListeners(event?: keyof TEvents): this {
		if (event !== undefined) this._listeners.delete(event);
		else this._listeners.clear();

		return this;
	}
}

// ---------------------------------------------------------------------------
// ClientState
// ---------------------------------------------------------------------------

/**
 * Lifecycle state of a WHIP or WHEP client instance.
 *
 * ```
 * idle → connecting → connected ↔ disconnected
 *                  ↘ failed
 *                  (any) → closed
 * ```
 */
export type ClientState =
	| 'idle'
	| 'connecting'
	| 'connected'
	| 'disconnected'
	| 'failed'
	| 'closed';

// ---------------------------------------------------------------------------
// BaseClient
// ---------------------------------------------------------------------------

/**
 * Abstract base class shared by `WHIPClient` and `WHEPClient`.
 *
 * Responsibilities:
 * - `RTCPeerConnection` lifecycle management
 * - HTTP signalling (POST / PATCH / DELETE)
 * - Bearer token injection
 * - Connection-state event forwarding
 * - Timeout handling
 * - Auto-reconnect orchestration
 * - Structured logging
 */
export abstract class BaseClient<
	TEvents extends BaseClientEvents,
> extends TypedEventEmitter<TEvents> {
	protected readonly options: Required<
		Omit<
			BaseClientOptions,
			'headers' | 'getHeaders' | 'logger' | 'autoReconnect' | 'iceConnectionTimeout'
		>
	> & {
		headers: Record<string, string> | undefined;
		getHeaders: (() => Record<string, string> | Promise<Record<string, string>>) | undefined;
		logger: Logger | undefined;
		autoReconnect: boolean | AutoReconnectOptions | undefined;
		iceConnectionTimeout: number | undefined;
	};

	protected pc: RTCPeerConnection | null = null;
	protected resourceUrl: string | null = null;

	/**
	 * The `ETag` value from the most recent successful WHIP/WHEP POST (or
	 * ICE-restart PATCH) response. Used by endpoint recovery to send an
	 * `If-Match` header per RFC 9725 §4.3. `null` until the first successful
	 * exchange and after the resource is deleted.
	 */
	protected etag: string | null = null;

	/** Set to `true` once the connection reaches `'connected'` for the first time. */
	protected _wasConnected = false;

	/** Incremented on each `stop()` or manual reconnect to cancel pending retries. */
	protected _reconnectToken = 0;

	private _state: ClientState = 'idle';

	constructor(options: BaseClientOptions) {
		super();
		this.options = {
			endpoint: options.endpoint,
			token: options.token ?? '',
			iceServers: options.iceServers ?? [],
			iceTransportPolicy: options.iceTransportPolicy ?? 'all',
			iceCandidatePoolSize: options.iceCandidatePoolSize ?? 0,
			timeout: options.timeout ?? 15_000,
			iceConnectionTimeout: options.iceConnectionTimeout,
			peerConnectionConfig: options.peerConnectionConfig ?? {},
			headers: options.headers,
			getHeaders: options.getHeaders,
			logger: options.logger,
			autoReconnect: options.autoReconnect,
		};
	}

	// -------------------------------------------------------------------------
	// Public accessors
	// -------------------------------------------------------------------------

	/** Current lifecycle state of the client. */
	get state(): ClientState {
		return this._state;
	}

	/**
	 * The resource URL returned by the server after a successful WHIP / WHEP
	 * POST. `null` before connection and after `stop()`.
	 */
	get resource(): string | null {
		return this.resourceUrl;
	}

	// -------------------------------------------------------------------------
	// RTCPeerConnection
	// -------------------------------------------------------------------------

	protected createPeerConnection(): RTCPeerConnection {
		const { iceServers, iceTransportPolicy, iceCandidatePoolSize, peerConnectionConfig } =
			this.options;

		const config: RTCConfiguration = {
			...peerConnectionConfig,
			bundlePolicy: peerConnectionConfig.bundlePolicy ?? 'max-bundle',
			iceTransportPolicy,
			iceCandidatePoolSize,
			...(iceServers.length > 0 && { iceServers }),
		};

		const pc = new RTCPeerConnection(config);
		this.pc = pc;

		this.options.logger?.debug('RTCPeerConnection created', { iceTransportPolicy });

		pc.addEventListener('connectionstatechange', () => this.handleConnectionStateChange(pc));
		pc.addEventListener('iceconnectionstatechange', () => {
			this.options.logger?.debug('ICE connection state', { state: pc.iceConnectionState });
			this.emitBase('iceconnectionstatechange', pc.iceConnectionState);
		});
		pc.addEventListener('icegatheringstatechange', () => {
			this.options.logger?.debug('ICE gathering state', { state: pc.iceGatheringState });
			this.emitBase('icegatheringstatechange', pc.iceGatheringState);
		});

		return pc;
	}

	/**
	 * Wait for the `RTCPeerConnection` to reach `'connected'` state.
	 *
	 * Resolves immediately when already connected. Rejects with a
	 * `TimeoutError` when `iceConnectionTimeout` is set and the deadline
	 * passes before the connection is established.
	 */
	protected waitForIceConnection(pc: RTCPeerConnection): Promise<void> {
		if (pc.connectionState === 'connected') return Promise.resolve();

		return new Promise<void>((resolve, reject) => {
			const timeout = this.options.iceConnectionTimeout;
			const timer = timeout
				? setTimeout(() => {
						cleanup();
						reject(
							new TimeoutError(
								timeout,
								`ICE connection timed out after ${timeout}ms`,
							),
						);
					}, timeout)
				: null;

			const handler = (): void => {
				const s = pc.connectionState;
				if (s === 'connected') {
					cleanup();
					resolve();
					return;
				}
				if (s === 'failed' || s === 'closed') {
					cleanup();
					reject(new WhipWhepError(`ICE connection ${s}`));
				}
			};

			const cleanup = (): void => {
				if (timer !== null) clearTimeout(timer);
				pc.removeEventListener('connectionstatechange', handler);
			};

			pc.addEventListener('connectionstatechange', handler);
		});
	}

	/**
	 * Dispatch connection-state transitions using an object-literal handler map.
	 */
	private handleConnectionStateChange(pc: RTCPeerConnection): void {
		const state = pc.connectionState;
		this.options.logger?.debug('Connection state changed', { state });
		this.emitBase('connectionstatechange', state);

		const handlers: Partial<Record<RTCPeerConnectionState, () => void>> = {
			connected: () => {
				this._state = 'connected';
				this._wasConnected = true;
				this.options.logger?.info('Connection established');
				this.emitBase('connected');
			},
			disconnected: () => {
				this._state = 'disconnected';
				this.options.logger?.warn('Connection disconnected – may recover');
				this.emitBase('disconnected');
			},
			failed: () => {
				this._state = 'failed';
				const err = new WhipWhepError('RTCPeerConnection failed');
				this.options.logger?.error('Connection failed', { error: err.message });
				this.emitBase('failed', err);
			},
		};

		handlers[state]?.();
	}

	/**
	 * Type-safe emit for events defined in `BaseClientEvents`.
	 */
	private emitBase<K extends keyof BaseClientEvents>(
		event: K,
		...args: Parameters<BaseClientEvents[K]>
	): void {
		(this.emit as (e: K, ...a: Parameters<BaseClientEvents[K]>) => void)(event, ...args);
	}

	// -------------------------------------------------------------------------
	// HTTP helpers
	// -------------------------------------------------------------------------

	/**
	 * Build request headers by merging all sources in priority order:
	 *
	 * 1. Built-in defaults (`Content-Type`, `Authorization` from `token`)
	 * 2. Static `headers` option
	 * 3. Dynamic `getHeaders()` return value  ← highest priority
	 * 4. `extra` (per-call overrides, e.g. `Content-Type` for PATCH)
	 */
	protected async buildHeaders(extra?: Record<string, string>): Promise<Headers> {
		const dynamic = this.options.getHeaders ? await this.options.getHeaders() : {};

		return new Headers({
			'Content-Type': 'application/sdp',
			...(this.options.token && { Authorization: `Bearer ${this.options.token}` }),
			...this.options.headers,
			...dynamic,
			...extra,
		});
	}

	/**
	 * POST an SDP offer to the WHIP / WHEP endpoint.
	 *
	 * @returns The SDP answer body and the resource URL from the `Location`
	 *   response header.
	 * @throws {TimeoutError}    When the request exceeds `options.timeout`.
	 * @throws {WhipWhepError}   On network errors or non-201 responses.
	 */
	protected async postSdpOffer(
		sdpOffer: string,
	): Promise<{ sdpAnswer: string; resourceUrl: string }> {
		this.options.logger?.debug('POST SDP offer', { endpoint: this.options.endpoint });

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.options.timeout);

		let response: Response;
		try {
			response = await fetch(this.options.endpoint, {
				method: 'POST',
				headers: await this.buildHeaders(),
				body: sdpOffer,
				signal: controller.signal,
			});
		} catch (err) {
			if (err instanceof DOMException && err.name === 'AbortError')
				throw new TimeoutError(this.options.timeout);
			throw new WhipWhepError('Network error during SDP POST', { cause: err });
		} finally {
			clearTimeout(timer);
		}

		if (response.status !== 201) {
			const body = await response.text().catch(() => '');
			const detail = body ? `: ${body}` : '';
			this.options.logger?.error('SDP POST rejected', { status: response.status });
			throw new WhipWhepError(
				`Server returned ${response.status} ${response.statusText}${detail}`,
				{ status: response.status },
			);
		}

		const sdpAnswer = await response.text();
		if (!sdpAnswer) throw new WhipWhepError('Server returned an empty SDP answer');

		const location = response.headers.get('Location');
		const resourceUrl = location
			? resolveUrl(location, this.options.endpoint)
			: this.options.endpoint;

		const etag = response.headers.get('ETag');
		if (etag) this.etag = etag;

		this.options.logger?.debug('SDP exchange complete', { resourceUrl });

		return { sdpAnswer, resourceUrl };
	}

	/**
	 * PATCH trickle ICE candidates to the resource URL (best-effort).
	 * Failures are silently ignored per the WHIP/WHEP spec.
	 */
	protected async patchIceCandidates(candidates: RTCIceCandidate[]): Promise<void> {
		if (!this.resourceUrl || candidates.length === 0) return;

		this.options.logger?.debug('PATCH ICE candidates', { count: candidates.length });

		const body = candidates.map((c) => `a=${c.candidate}`).join('\r\n');

		try {
			await fetch(this.resourceUrl, {
				method: 'PATCH',
				headers: await this.buildHeaders({
					'Content-Type': 'application/trickle-ice-sdpfrag',
				}),
				body,
			});
		} catch {
			// Intentionally ignored – trickle ICE is best-effort
		}
	}

	/**
	 * Send an HTTP DELETE to release the WHIP / WHEP resource on the server.
	 * Best-effort: failures are silently ignored.
	 */
	protected async deleteResource(): Promise<void> {
		if (!this.resourceUrl) return;

		const url = this.resourceUrl;
		this.resourceUrl = null;
		this.etag = null;

		this.options.logger?.debug('DELETE resource', { url });

		try {
			await fetch(url, { method: 'DELETE', headers: await this.buildHeaders() });
		} catch {
			// Intentionally ignored – cleanup is best-effort
		}
	}

	// -------------------------------------------------------------------------
	// Reconnect helpers
	// -------------------------------------------------------------------------

	/**
	 * Tear down the current peer connection and delete the server resource
	 * **without** removing event listeners. Used by the reconnect flow so
	 * that user-registered handlers survive the reconnect cycle.
	 */
	protected async teardownForReconnect(): Promise<void> {
		this.onBeforeTeardown();
		this.pc?.close();
		this.pc = null;
		await this.deleteResource();
	}

	/**
	 * Close the peer connection **without** deleting the server resource or
	 * clearing the resource URL / ETag. Used by the endpoint-recovery flow so
	 * that the session can be resumed via a PATCH rather than a full
	 * DELETE + POST cycle.
	 */
	protected teardownPcOnly(): void {
		this.onBeforeTeardown();
		this.pc?.close();
		this.pc = null;
	}

	/**
	 * Override in subclasses to clean up ICE trickle handlers before
	 * `teardownForReconnect` closes the peer connection.
	 */
	protected onBeforeTeardown(): void {
		// Overridden by WHIPClient and WHEPClient
	}

	/**
	 * PATCH a new SDP offer to the existing WHIP resource URL to perform an
	 * ICE restart per RFC 9725 §4.3.
	 *
	 * Sends `Content-Type: application/sdp` with an `If-Match` header
	 * containing the session ETag (when available). Expects a `200 OK`
	 * response with a new SDP answer; any other status causes a
	 * `WhipWhepError` to be thrown so the caller can fall back to a full
	 * reconnect.
	 *
	 * On success, the ETag is updated from the response headers.
	 *
	 * @throws {TimeoutError}  When the request exceeds `options.timeout`.
	 * @throws {WhipWhepError} On network error or non-200 response.
	 */
	protected async patchSdpForIceRestart(sdpOffer: string): Promise<string> {
		if (!this.resourceUrl) throw new WhipWhepError('No active resource URL for ICE restart');

		this.options.logger?.debug('PATCH SDP for ICE restart', { resourceUrl: this.resourceUrl });

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.options.timeout);

		const extraHeaders: Record<string, string> = { 'Content-Type': 'application/sdp' };
		if (this.etag) extraHeaders['If-Match'] = this.etag;

		let response: Response;
		try {
			response = await fetch(this.resourceUrl, {
				method: 'PATCH',
				headers: await this.buildHeaders(extraHeaders),
				body: sdpOffer,
				signal: controller.signal,
			});
		} catch (err) {
			if (err instanceof DOMException && err.name === 'AbortError')
				throw new TimeoutError(this.options.timeout);
			throw new WhipWhepError('Network error during ICE restart PATCH', { cause: err });
		} finally {
			clearTimeout(timer);
		}

		if (response.status !== 200) {
			const body = await response.text().catch(() => '');
			const detail = body ? `: ${body}` : '';
			this.options.logger?.warn('ICE restart PATCH rejected', { status: response.status });
			throw new WhipWhepError(
				`ICE restart rejected with status ${response.status}${detail}`,
				{ status: response.status },
			);
		}

		const sdpAnswer = await response.text();
		if (!sdpAnswer) throw new WhipWhepError('Server returned empty SDP answer for ICE restart');

		const newEtag = response.headers.get('ETag');
		if (newEtag) this.etag = newEtag;

		this.options.logger?.debug('ICE restart complete');

		return sdpAnswer;
	}

	/**
	 * Run a retry loop calling `callback` up to `opts.maxAttempts` times.
	 *
	 * Emits `'reconnecting'` before each attempt and `'reconnected'` on
	 * success. After exhausting all attempts, emits a final `'failed'`.
	 * Stops early when `token` no longer matches `this._reconnectToken`
	 * (i.e. `stop()` was called).
	 */
	protected async scheduleReconnect(callback: () => Promise<void>, token: number): Promise<void> {
		const opts = this.resolveAutoReconnect();
		if (!opts) return;

		let attempt = 0;

		while (attempt < opts.maxAttempts && this._reconnectToken === token) {
			const delay =
				attempt === 0
					? 0
					: Math.min(
							opts.backoff === 'exponential'
								? opts.initialDelayMs * 2 ** (attempt - 1)
								: opts.initialDelayMs,
							opts.maxDelayMs,
						);

			this.options.logger?.info('Reconnecting', { attempt: attempt + 1, delayMs: delay });
			this.emitBase('reconnecting', attempt + 1, delay);

			if (delay > 0) await sleep(delay);
			if (this._reconnectToken !== token) return;

			attempt++;

			try {
				await callback();
				if (this._reconnectToken === token) {
					this.options.logger?.info('Reconnected successfully');
					this.emitBase('reconnected');
				}
				return;
			} catch (err) {
				this.options.logger?.warn('Reconnect attempt failed', {
					attempt,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}

		if (this._reconnectToken === token) {
			const err = new WhipWhepError(
				`Auto-reconnect failed after ${opts.maxAttempts} attempt(s)`,
			);
			this.options.logger?.error('Auto-reconnect exhausted', { attempts: opts.maxAttempts });
			this.emitBase('failed', err);
		}
	}

	private resolveAutoReconnect(): Required<AutoReconnectOptions> | null {
		const raw = this.options.autoReconnect;
		if (!raw) return null;
		const opts = typeof raw === 'boolean' ? {} : raw;
		return {
			maxAttempts: opts.maxAttempts ?? 5,
			initialDelayMs: opts.initialDelayMs ?? 1_000,
			maxDelayMs: opts.maxDelayMs ?? 30_000,
			backoff: opts.backoff ?? 'exponential',
		};
	}

	// -------------------------------------------------------------------------
	// Lifecycle helpers
	// -------------------------------------------------------------------------

	protected setState(state: ClientState): void {
		this._state = state;
	}

	/** Close the peer connection and clear all event listeners. */
	protected close(): void {
		this.pc?.close();
		this.pc = null;
		this._state = 'closed';
		this.removeAllListeners();
	}

	// -------------------------------------------------------------------------
	// Guard helpers
	// -------------------------------------------------------------------------

	protected assertIdle(methodName: string): void {
		if (this._state === 'idle') return;
		throw new InvalidStateError(
			`Cannot call ${methodName}() when client is in "${this._state}" state. ` +
				`Use reconnect() to re-establish the connection, or create a new instance.`,
		);
	}
}

// ---------------------------------------------------------------------------
// Module-private utilities
// ---------------------------------------------------------------------------

const resolveUrl = (location: string, base: string): string => {
	try {
		return new URL(location).href;
	} catch {
		return new URL(location, base).href;
	}
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
