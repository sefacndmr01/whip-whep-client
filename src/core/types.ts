// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

/**
 * Minimal logger interface compatible with `console`, `pino`, `winston`, and
 * most structured logging libraries.
 *
 * Pass `logger: console` during development to see all internal events.
 */
export interface Logger {
	debug(message: string, ...args: unknown[]): void;
	info(message: string, ...args: unknown[]): void;
	warn(message: string, ...args: unknown[]): void;
	error(message: string, ...args: unknown[]): void;
}

// ---------------------------------------------------------------------------
// Auto-reconnect
// ---------------------------------------------------------------------------

/**
 * Configuration for the automatic reconnect behaviour.
 *
 * Pass `autoReconnect: true` to use all defaults, or provide an object to
 * fine-tune the retry policy.
 */
export interface AutoReconnectOptions {
	/**
	 * Maximum number of reconnection attempts before emitting a final
	 * `'failed'` event. Defaults to `5`.
	 */
	maxAttempts?: number;

	/**
	 * Delay before the **second** attempt (the first retry is immediate).
	 * Subsequent delays grow according to `backoff`. Defaults to `1_000` ms.
	 */
	initialDelayMs?: number;

	/**
	 * Upper bound on the inter-attempt delay. Defaults to `30_000` ms.
	 */
	maxDelayMs?: number;

	/**
	 * Delay growth strategy.
	 * - `'exponential'` – delay doubles on each attempt (default).
	 * - `'fixed'` – delay stays at `initialDelayMs`.
	 */
	backoff?: 'fixed' | 'exponential';
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

/** Overall connection quality derived from packet-loss rate and RTT. */
export type ConnectionQuality = 'excellent' | 'good' | 'fair' | 'poor';

/** Audio-track statistics snapshot. */
export interface AudioStats {
	/** Current encoding / decoding bitrate in **bits per second**. */
	bitrate: number;
	/** Total packets lost since the session started. */
	packetsLost: number;
	/** Fraction of packets lost (0–1). */
	packetsLostRate: number;
	/** Jitter in **seconds** (from RTCP). */
	jitter: number;
}

/** Video-track statistics snapshot. */
export interface VideoStats {
	/** Current encoding / decoding bitrate in **bits per second**. */
	bitrate: number;
	/** Total packets lost since the session started. */
	packetsLost: number;
	/** Fraction of packets lost (0–1). */
	packetsLostRate: number;
	/** Current frames per second. */
	frameRate: number;
	/** Frame width in pixels. */
	width: number;
	/** Frame height in pixels. */
	height: number;
}

/**
 * Normalised snapshot of `RTCPeerConnection.getStats()` returned by
 * `WHIPClient.getStats()` and `WHEPClient.getStats()`.
 */
export interface StreamStats {
	/** Timestamp when the snapshot was collected (ms since epoch). */
	timestamp: number;
	/** Audio statistics, or `null` when no audio track is active. */
	audio: AudioStats | null;
	/** Video statistics, or `null` when no video track is active. */
	video: VideoStats | null;
	/**
	 * Round-trip time in **seconds**.
	 *
	 * - For `WHIPClient` (sender): derived from RTCP SR/RR reports via
	 *   `remote-inbound-rtp` stats. `null` until the first RTCP measurement.
	 * - For `WHEPClient` (receiver): derived from ICE candidate-pair stats
	 *   (`nominated` pair preferred). `null` until the ICE connection is
	 *   fully established.
	 */
	roundTripTime: number | null;
	/** Overall connection quality derived from packet loss and RTT. */
	quality: ConnectionQuality;
}

// ---------------------------------------------------------------------------
// Base client options
// ---------------------------------------------------------------------------

/**
 * Configuration options shared by both WHIP and WHEP clients.
 */
export interface BaseClientOptions {
	/**
	 * The WHIP or WHEP endpoint URL.
	 */
	endpoint: string;

	/**
	 * Optional Bearer token sent as `Authorization: Bearer <token>`.
	 *
	 * For custom authorization schemes (e.g. `Token`, `Basic`, `Digest`) use
	 * `headers` or `getHeaders` instead and omit this field.
	 */
	token?: string;

	/**
	 * Static custom headers appended to every HTTP request (POST, PATCH,
	 * DELETE). Merged after built-in headers, so keys like `Authorization`
	 * and `Content-Type` can be overridden here.
	 *
	 * @example
	 * ```ts
	 * headers: {
	 *   'X-API-Key': 'my-key',
	 *   'Authorization': 'Token abc123',   // overrides the token option
	 * }
	 * ```
	 */
	headers?: Record<string, string>;

	/**
	 * A function called before **each** HTTP request to supply dynamic
	 * headers. The returned headers are merged on top of `headers`.
	 *
	 * Use this when the header value must be freshly computed per request,
	 * for example:
	 * - Refreshable access tokens
	 * - HMAC / timestamp-based request signatures
	 * - Session cookies obtained asynchronously
	 *
	 * @example
	 * ```ts
	 * getHeaders: async () => ({
	 *   'Authorization': `Bearer ${await tokenStore.getValidToken()}`,
	 * })
	 * ```
	 */
	getHeaders?: () => Record<string, string> | Promise<Record<string, string>>;

	/**
	 * Custom ICE servers (STUN/TURN). Overrides browser defaults when provided.
	 */
	iceServers?: RTCIceServer[];

	/**
	 * ICE transport policy. Defaults to `'all'`.
	 * Set to `'relay'` to force TURN relay usage only.
	 */
	iceTransportPolicy?: RTCIceTransportPolicy;

	/**
	 * Number of ICE candidates to pre-gather before the offer is sent.
	 * Increasing this value improves connection time at the cost of higher
	 * initial memory usage. Defaults to `0`.
	 */
	iceCandidatePoolSize?: number;

	/**
	 * Maximum time in milliseconds to wait for the SDP exchange to complete.
	 * Defaults to `15000` (15 seconds).
	 */
	timeout?: number;

	/**
	 * Additional `RTCConfiguration` fields merged with library defaults.
	 * `iceServers`, `iceTransportPolicy`, and `iceCandidatePoolSize` from
	 * this object are ignored in favour of the dedicated top-level options.
	 */
	peerConnectionConfig?: Omit<
		RTCConfiguration,
		'iceServers' | 'iceTransportPolicy' | 'iceCandidatePoolSize'
	>;

	/**
	 * Maximum time in milliseconds to wait for the ICE connection to reach
	 * the `'connected'` state after `setRemoteDescription`.
	 *
	 * When omitted (default) no ICE-specific timeout is applied; only the
	 * SDP-exchange `timeout` is enforced. When set, a `TimeoutError` is
	 * thrown if ICE does not connect within the given window.
	 */
	iceConnectionTimeout?: number;

	/**
	 * Enable automatic reconnection when the underlying `RTCPeerConnection`
	 * transitions to the `'failed'` state after a previously successful
	 * connection.
	 *
	 * - `true` – use default retry policy (5 attempts, exponential back-off).
	 * - `AutoReconnectOptions` – customise attempt count, delays, and strategy.
	 *
	 * Auto-reconnect does **not** trigger for errors that occur during the
	 * initial signalling (e.g. a 401 from the server).
	 */
	autoReconnect?: boolean | AutoReconnectOptions;

	/**
	 * Optional logger for internal debug output.
	 *
	 * Any object with `debug`, `info`, `warn`, and `error` methods is
	 * accepted, including the global `console`.
	 *
	 * @example
	 * ```ts
	 * const client = new WHIPClient({ endpoint: '...', logger: console });
	 * ```
	 */
	logger?: Logger;
}

// ---------------------------------------------------------------------------
// Audio options
// ---------------------------------------------------------------------------

/**
 * Advanced Opus codec parameters.
 *
 * These map to well-known `a=fmtp` parameters defined in RFC 7587.
 */
export interface AudioEncodingOptions {
	/**
	 * Maximum audio encoding bitrate in **bits per second**.
	 * Applied via `RTCRtpSender.setParameters()` after negotiation.
	 *
	 * @example 128_000  // 128 kbps
	 */
	maxBitrate?: number;

	/**
	 * Enable Discontinuous Transmission (DTX) for Opus.
	 * Reduces bitrate during silence by ~1 kbps. Defaults to `false`.
	 */
	dtx?: boolean;

	/**
	 * Force stereo audio. Defaults to `false` (mono).
	 */
	stereo?: boolean;

	/**
	 * Enable in-band Forward Error Correction (FEC) for Opus.
	 * Improves packet-loss resilience. Defaults to `true`.
	 */
	fec?: boolean;

	/**
	 * Enable comfort noise generation. Defaults to `false`.
	 */
	comfortNoise?: boolean;

	/**
	 * Hint to the browser about the nature of the audio content.
	 * Browsers may use this to choose encoder settings.
	 *
	 * - `'speech'` – optimize for voice (default in most browsers)
	 * - `'speech-recognition'` – optimize for speech recognition
	 * - `'music'` – optimize for music / wide-band audio
	 * - `''` – no hint (browser decides)
	 */
	contentHint?: 'speech' | 'speech-recognition' | 'music' | '';
}

// ---------------------------------------------------------------------------
// Video options
// ---------------------------------------------------------------------------

/**
 * Advanced video encoding parameters for a single quality layer.
 *
 * Extends the standard `RTCRtpEncodingParameters` with convenience aliases.
 */
export interface VideoLayerOptions {
	/**
	 * RID label for simulcast layers (e.g. `'high'`, `'mid'`, `'low'`).
	 * Required when simulcast is enabled.
	 */
	rid?: string;

	/**
	 * Maximum video encoding bitrate in **bits per second**.
	 *
	 * @example 2_500_000  // 2.5 Mbps
	 */
	maxBitrate?: number;

	/**
	 * Maximum frames per second for this layer.
	 */
	maxFramerate?: number;

	/**
	 * Downscale factor relative to the source resolution.
	 * `1` = full resolution, `2` = half resolution, `4` = quarter resolution.
	 * Defaults to `1`.
	 */
	scaleResolutionDownBy?: number;

	/**
	 * Whether this layer is active. Defaults to `true`.
	 */
	active?: boolean;

	/**
	 * How to degrade quality when bandwidth is constrained.
	 * Defaults to `'balanced'`.
	 */
	degradationPreference?: RTCDegradationPreference;

	/**
	 * Hint to the encoder about the content type.
	 * `'motion'` optimises for fast movement (sports, games).
	 * `'detail'` optimises for sharpness (screen share, slides).
	 */
	contentHint?: 'motion' | 'detail' | 'text' | '';
}

// ---------------------------------------------------------------------------
// Client options
// ---------------------------------------------------------------------------

/**
 * Options specific to the WHIP (ingestion / publishing) client.
 */
export interface WHIPClientOptions extends BaseClientOptions {
	/**
	 * Enable simulcast for the video track with three quality layers:
	 * `high`, `mid`, and `low`. Defaults to `false`.
	 *
	 * Use `videoLayers` to override the default layer configuration.
	 */
	simulcast?: boolean;

	/**
	 * Preferred audio codec name (e.g. `'opus'`).
	 * Reorders the SDP payload type list so the preferred codec is offered first.
	 */
	audioCodec?: string;

	/**
	 * Preferred video codec name (e.g. `'h264'`, `'vp8'`, `'vp9'`, `'av1'`).
	 * Reorders the SDP payload type list so the preferred codec is offered first.
	 */
	videoCodec?: string;

	/**
	 * Advanced audio encoding options (bitrate, DTX, stereo, FEC…).
	 */
	audio?: AudioEncodingOptions;

	/**
	 * Advanced video layer options.
	 *
	 * - When `simulcast` is **false**, provide a single `VideoLayerOptions`
	 *   object to configure the single encoding layer.
	 * - When `simulcast` is **true**, provide an array of up to three
	 *   `VideoLayerOptions` objects (ordered high → low quality) to override
	 *   the built-in simulcast defaults.
	 */
	video?: VideoLayerOptions | VideoLayerOptions[];

	/**
	 * Maximum total **session** bandwidth in **kilobits per second**.
	 * Written as `b=AS:<maxKbps>` in the SDP offer.
	 *
	 * This is a hint to the server; actual enforcement depends on the server
	 * implementation. For per-layer bitrate limits prefer `video.maxBitrate`.
	 *
	 * @example 4_000  // 4 Mbps
	 */
	maxBandwidth?: number;
}

/**
 * Options specific to the WHEP (egress / viewing) client.
 */
export interface WHEPClientOptions extends BaseClientOptions {
	/**
	 * Preferred audio codec name for the inbound stream (e.g. `'opus'`).
	 */
	audioCodec?: string;

	/**
	 * Preferred video codec name for the inbound stream (e.g. `'h264'`, `'vp8'`).
	 */
	videoCodec?: string;

	/**
	 * Maximum receive bandwidth per media section in **kilobits per second**.
	 * Written as `b=AS:<maxKbps>` in the SDP offer to hint the server to
	 * limit the outgoing bitrate to this value.
	 */
	maxBandwidth?: number;
}

// ---------------------------------------------------------------------------
// Per-call options
// ---------------------------------------------------------------------------

/**
 * Per-track publish options passed to `WHIPClient.publish()`.
 */
export interface PublishOptions {
	/**
	 * Set to `false` to skip publishing the audio track even if the stream
	 * contains one. Defaults to `true`.
	 */
	audio?: boolean;

	/**
	 * Set to `false` to skip publishing the video track even if the stream
	 * contains one. Defaults to `true`.
	 */
	video?: boolean;

	/**
	 * Override simulcast for this specific `publish()` call.
	 * Takes precedence over the constructor-level `simulcast` option.
	 */
	simulcast?: boolean;
}

/**
 * Options passed to `WHEPClient.view()`.
 */
export interface ViewOptions {
	/**
	 * Set to `false` to skip adding an audio receive transceiver.
	 * Defaults to `true`.
	 */
	audio?: boolean;

	/**
	 * Set to `false` to skip adding a video receive transceiver.
	 * Defaults to `true`.
	 */
	video?: boolean;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * Generic typed event listener map used internally by `TypedEventEmitter`.
 * @internal
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type EventMap = Record<string, (...args: any[]) => void>;

/**
 * Event map for the base client (shared by both WHIP and WHEP).
 *
 * The index signature `[event: string]` is required so the interface
 * satisfies the `EventMap` constraint on `TypedEventEmitter`. It does not
 * weaken the typed overloads for known events.
 */
export interface BaseClientEvents extends EventMap {
	/** Fired when the ICE + DTLS connection is fully established. */
	connected: () => void;

	/**
	 * Fired when the peer connection transitions to `disconnected` state.
	 * Media may recover automatically; wait for `failed` before giving up.
	 */
	disconnected: () => void;

	/** Fired when the connection has irrecoverably failed. */
	failed: (error: Error) => void;

	/** Fired on every `RTCPeerConnection.connectionState` change. */
	connectionstatechange: (state: RTCPeerConnectionState) => void;

	/** Fired on every `RTCPeerConnection.iceConnectionState` change. */
	iceconnectionstatechange: (state: RTCIceConnectionState) => void;

	/** Fired on every `RTCPeerConnection.iceGatheringState` change. */
	icegatheringstatechange: (state: RTCIceGatheringState) => void;

	/**
	 * Fired at the start of each auto-reconnect attempt.
	 *
	 * @param attempt  1-based attempt number.
	 * @param delayMs  Milliseconds the library waited before this attempt.
	 */
	reconnecting: (attempt: number, delayMs: number) => void;

	/** Fired when an auto-reconnect attempt successfully re-establishes the session. */
	reconnected: () => void;
}

/**
 * Events emitted exclusively by the WHEP viewer client.
 */
export interface WHEPClientEvents extends BaseClientEvents {
	/**
	 * Fired when the remote `MediaStream` is ready to be attached to a
	 * `<video>` or `<audio>` element.
	 */
	stream: (stream: MediaStream) => void;
}

/** Events emitted by the WHIP publisher client. */
export type WHIPClientEvents = BaseClientEvents;
