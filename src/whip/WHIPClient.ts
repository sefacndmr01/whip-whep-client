import { BaseClient } from '../core/BaseClient.js';
import type {
	WHIPClientOptions,
	WHIPClientEvents,
	PublishOptions,
	PublishScreenOptions,
	StreamStats,
	StatsHistory,
	AudioStats,
	VideoStats,
	AdaptiveQualityOptions,
	ConnectionQuality,
} from '../core/types.js';
import { WHIPError, InvalidStateError } from '../core/errors.js';
import { preferCodec, addSimulcast, setBandwidth, patchFmtp } from '../utils/sdp.js';
import { setupIceTrickle } from '../utils/ice.js';
import { getScreenStream } from '../utils/media.js';
import { computeQuality, StatsHistoryImpl, type StatsSnapshot } from '../utils/stats.js';
import {
	DEFAULT_SIMULCAST_LAYERS,
	toRtcEncoding,
	applyLayerToEncoding,
	buildOpusFmtp,
} from './encodings.js';

// ---------------------------------------------------------------------------
// Adaptive quality constants
// ---------------------------------------------------------------------------

/** Numeric rank used to compare quality levels (higher = better). */
const QUALITY_RANK: Record<ConnectionQuality, number> = {
	poor: 0,
	fair: 1,
	good: 2,
	excellent: 3,
};

/**
 * Fraction of the target bitrate applied at each quality level.
 * Applied to the single-layer video sender's `maxBitrate`.
 */
const QUALITY_FACTORS: Record<ConnectionQuality, number> = {
	poor: 0.25,
	fair: 0.5,
	good: 0.75,
	excellent: 1.0,
};

// ---------------------------------------------------------------------------
// WHIPClient
// ---------------------------------------------------------------------------

/**
 * WHIP (WebRTC-HTTP Ingestion Protocol – RFC 9725) client.
 *
 * Publishes a `MediaStream` to a WHIP-compatible ingest server using a
 * single SDP offer/answer exchange over HTTP POST, followed by an optional
 * trickle-ICE exchange via HTTP PATCH.
 *
 * ### Minimal usage
 *
 * ```ts
 * const client = new WHIPClient({ endpoint: 'https://ingest.example.com/whip/live' });
 * const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
 * await client.publish(stream);
 * // …
 * await client.stop();
 * ```
 *
 * ### Advanced usage
 *
 * ```ts
 * const client = new WHIPClient({
 *   endpoint: 'https://ingest.example.com/whip/live',
 *   token: 'my-secret',
 *   simulcast: true,
 *   videoCodec: 'h264',
 *   maxBandwidth: 4_000,          // 4 Mbps session limit (b=AS in SDP)
 *   audio: {
 *     maxBitrate: 128_000,        // 128 kbps
 *     dtx: true,
 *     stereo: true,
 *     fec: true,
 *   },
 *   video: [
 *     { rid: 'high', maxBitrate: 2_500_000, scaleResolutionDownBy: 1 },
 *     { rid: 'mid',  maxBitrate: 1_000_000, scaleResolutionDownBy: 2 },
 *     { rid: 'low',  maxBitrate: 300_000,   scaleResolutionDownBy: 4 },
 *   ],
 * });
 * ```
 */
export class WHIPClient extends BaseClient<WHIPClientEvents> {
	private readonly whipOptions: WHIPClientOptions;
	private cleanupIce: (() => void) | null = null;

	private _lastStream: MediaStream | null = null;
	private _lastPublishOptions: PublishOptions = {};
	private _statsSnapshot: StatsSnapshot | null = null;

	// Adaptive quality state
	private _adaptiveTimer: ReturnType<typeof setInterval> | null = null;
	private _targetBitrate: number | null = null;
	private _currentAdaptiveQuality: ConnectionQuality = 'excellent';
	private _degradedCount = 0;
	private _improvedCount = 0;

	// Audio level monitor state
	private _audioMonitorTimer: ReturnType<typeof setInterval> | null = null;
	private _audioContext: AudioContext | null = null;
	private _audioAnalyser: AnalyserNode | null = null;
	private _audioLevelBuffer: Float32Array<ArrayBuffer> | null = null;

	constructor(options: WHIPClientOptions) {
		super(options);
		this.whipOptions = options;

		if (options.autoReconnect) {
			this.on('failed', () => {
				if (this._wasConnected && this._lastStream) {
					this._wasConnected = false;
					const token = this._reconnectToken;
					void this.scheduleReconnect(() => this._doReconnect(), token);
				}
			});
		}
	}

	/**
	 * Publish a `MediaStream` to the WHIP endpoint.
	 *
	 * Steps performed:
	 * 1. Create `RTCPeerConnection`
	 * 2. Add media tracks / configure encodings
	 * 3. Munge SDP (codec order, simulcast, bandwidth)
	 * 4. `POST` offer → receive answer → `setRemoteDescription`
	 * 5. Apply post-negotiation bitrate constraints via `RTCRtpSender.setParameters()`
	 * 6. Wait for ICE connection (when `iceConnectionTimeout` is set)
	 * 7. Start trickle-ICE PATCH in the background
	 *
	 * @param stream  The `MediaStream` to publish.
	 * @param options Per-call overrides for audio/video flags and simulcast.
	 *
	 * @throws {WHIPError}         On server rejection or network error.
	 * @throws {TimeoutError}      When the SDP or ICE exchange exceeds its timeout.
	 * @throws {InvalidStateError} When `publish()` is called on a non-idle client.
	 */
	async publish(stream: MediaStream, options: PublishOptions = {}): Promise<void> {
		this.assertIdle('publish');
		this.setState('connecting');

		this._lastStream = stream;
		this._lastPublishOptions = options;
		this._statsSnapshot = null;

		const { audio = true, video = true, signal } = options;
		const useSimulcast = options.simulcast ?? this.whipOptions.simulcast ?? false;

		if (signal?.aborted) {
			this.setState('failed');
			this.close();
			throw new DOMException('Aborted', 'AbortError');
		}

		this.options.logger?.info('Publishing stream', { audio, video, simulcast: useSimulcast });

		try {
			const pc = this.createPeerConnection();

			if (audio) this.addAudioTransceiver(pc, stream);
			if (video) this.addVideoTransceiver(pc, stream, useSimulcast);

			const offer = await pc.createOffer();
			const sdp = this.mutateSdpOffer(offer.sdp ?? '', useSimulcast);

			await pc.setLocalDescription({ type: 'offer', sdp });

			const { sdpAnswer, resourceUrl } = await this.postSdpOffer(sdp, signal).catch((err) => {
				// Propagate AbortError as-is so callers can distinguish intentional aborts
				if (err instanceof DOMException && err.name === 'AbortError') throw err;
				throw err instanceof WHIPError
					? err
					: new WHIPError('Failed to exchange SDP with WHIP endpoint', { cause: err });
			});

			this.resourceUrl = resourceUrl;

			if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

			await pc.setRemoteDescription({ type: 'answer', sdp: sdpAnswer });

			await this.applyEncodingConstraints(pc);
			await this.waitForIceConnection(pc);

			this.cleanupIce = setupIceTrickle(pc, {
				mode: 'end-of-candidates',
				onCandidates: (candidates) => this.patchIceCandidates(candidates),
			});

			this.startAdaptiveQuality();
		} catch (err) {
			this.setState('failed');
			await this.deleteResource();
			this.close();
			throw err;
		}
	}

	/**
	 * Stop publishing and release all resources.
	 *
	 * Sends an HTTP DELETE to the WHIP resource URL (if available) and closes
	 * the peer connection. Safe to call multiple times.
	 */
	async stop(): Promise<void> {
		if (this.state === 'closed') return;

		this._reconnectToken++;
		this.options.logger?.info('Stopping WHIP client');

		this.cleanupIce?.();
		this.cleanupIce = null;
		this.stopAdaptiveQuality();
		this.stopAudioLevelMonitor();

		await this.deleteResource();
		this.close();
	}

	/**
	 * Re-establish the WHIP session using the stream from the last `publish()`
	 * call. Cleans up the current peer connection, resets internal state, and
	 * calls `publish()` again.
	 *
	 * Useful for manually triggering a reconnect after a `'failed'` event.
	 *
	 * @throws {InvalidStateError} When called before `publish()` has been called.
	 */
	async reconnect(): Promise<void> {
		if (!this._lastStream)
			throw new InvalidStateError(
				'No stream to reconnect with. Call publish() at least once first.',
			);

		this._reconnectToken++;
		await this._doReconnect();
	}

	/**
	 * Mute the active audio or video sender by disabling its track.
	 *
	 * Disabling the track sends silence (audio) or a black frame (video) to the
	 * remote peer without re-negotiation. The sender remains active and can be
	 * unmuted instantly via `unmuteTrack()`.
	 *
	 * @param kind `'audio'` or `'video'`.
	 * @throws {InvalidStateError} When there is no active sender for the given kind.
	 */
	muteTrack(kind: 'audio' | 'video'): void {
		if (!this.pc) throw new InvalidStateError('No active peer connection');
		const sender = this.pc.getSenders().find((s) => s.track?.kind === kind);
		if (!sender?.track) throw new InvalidStateError(`No active ${kind} sender`);
		sender.track.enabled = false;
		this.options.logger?.debug('Track muted', { kind });
	}

	/**
	 * Unmute the active audio or video sender by re-enabling its track.
	 *
	 * @param kind `'audio'` or `'video'`.
	 * @throws {InvalidStateError} When there is no active sender for the given kind.
	 */
	unmuteTrack(kind: 'audio' | 'video'): void {
		if (!this.pc) throw new InvalidStateError('No active peer connection');
		const sender = this.pc.getSenders().find((s) => s.track?.kind === kind);
		if (!sender?.track) throw new InvalidStateError(`No active ${kind} sender`);
		sender.track.enabled = true;
		this.options.logger?.debug('Track unmuted', { kind });
	}

	/**
	 * Returns `true` when the given track kind is currently muted (i.e. the
	 * underlying `MediaStreamTrack.enabled` is `false`).
	 *
	 * @param kind `'audio'` or `'video'`.
	 * @throws {InvalidStateError} When there is no active sender for the given kind.
	 */
	isTrackMuted(kind: 'audio' | 'video'): boolean {
		if (!this.pc) throw new InvalidStateError('No active peer connection');
		const sender = this.pc.getSenders().find((s) => s.track?.kind === kind);
		if (!sender?.track) throw new InvalidStateError(`No active ${kind} sender`);
		return !sender.track.enabled;
	}

	/**
	 * Capture the screen / window / tab and publish it to the WHIP endpoint.
	 *
	 * Calls `getDisplayMedia` internally (triggering the browser's native
	 * screen-picker). An optional microphone track can be added via
	 * `micAudio`. The captured `MediaStream` is returned so the caller can
	 * stop individual tracks when sharing ends.
	 *
	 * **Typical usage**
	 * ```ts
	 * const stream = await client.publishScreen({ micAudio: true });
	 *
	 * // Stop sharing when the user clicks a button
	 * stopBtn.onclick = () => {
	 *   for (const t of stream.getTracks()) t.stop();
	 *   await client.stop();
	 * };
	 * ```
	 *
	 * @param options Screen capture and publish configuration.
	 * @returns The captured `MediaStream` (video + optional audio tracks).
	 *
	 * @throws {DOMException}      `'NotAllowedError'` when the user denies the screen picker.
	 * @throws {WHIPError}         On server rejection or network error.
	 * @throws {InvalidStateError} When the client is not in the `'idle'` state.
	 */
	async publishScreen(options: PublishScreenOptions = {}): Promise<MediaStream> {
		this.assertIdle('publishScreen');

		const displayStream = await getScreenStream({
			audio: options.displayAudio ?? false,
			...(options.videoConstraints && { videoConstraints: options.videoConstraints }),
		});

		let audioTrack: MediaStreamTrack | undefined;

		if (options.micAudio) {
			const constraints = typeof options.micAudio === 'boolean' ? true : options.micAudio;
			const micStream = await navigator.mediaDevices
				.getUserMedia({ audio: constraints, video: false })
				.catch((err) => {
					for (const t of displayStream.getTracks()) t.stop();
					throw err;
				});
			audioTrack = micStream.getAudioTracks()[0];
		} else if (options.displayAudio) {
			audioTrack = displayStream.getAudioTracks()[0];
		}

		const stream = new MediaStream([
			...displayStream.getVideoTracks(),
			...(audioTrack ? [audioTrack] : []),
		]);

		await this.publish(stream, {
			...options.publishOptions,
			audio: !!audioTrack,
			video: true,
		}).catch((err) => {
			for (const t of stream.getTracks()) t.stop();
			throw err;
		});

		return stream;
	}

	/**
	 * Start monitoring the outgoing audio level and emitting `'audiolevel'`
	 * events at the given interval.
	 *
	 * Internally creates an `AudioContext` and connects the active audio
	 * sender's track to an `AnalyserNode`. The emitted `level` value is the
	 * normalised RMS amplitude of the audio signal in the range **[0, 1]**.
	 *
	 * Call `stopAudioLevelMonitor()` to release the `AudioContext` and stop
	 * the polling timer. The monitor is stopped automatically by `stop()`.
	 *
	 * @param intervalMs Polling interval in milliseconds. Defaults to `100`.
	 * @throws {InvalidStateError} When called before `publish()` or when there
	 *   is no active audio sender.
	 */
	startAudioLevelMonitor(intervalMs = 100): void {
		if (!this.pc) throw new InvalidStateError('No active peer connection');

		const sender = this.pc.getSenders().find((s) => s.track?.kind === 'audio');
		if (!sender?.track) throw new InvalidStateError('No active audio sender');

		this.stopAudioLevelMonitor();

		const ctx = new AudioContext();
		const source = ctx.createMediaStreamSource(new MediaStream([sender.track]));
		const analyser = ctx.createAnalyser();
		analyser.fftSize = 256;
		source.connect(analyser);

		this._audioContext = ctx;
		this._audioAnalyser = analyser;
		this._audioLevelBuffer = new Float32Array(analyser.frequencyBinCount);

		this._audioMonitorTimer = setInterval(() => {
			if (!this._audioAnalyser || !this._audioLevelBuffer) return;
			this._audioAnalyser.getFloatTimeDomainData(this._audioLevelBuffer);
			let sum = 0;
			for (const val of this._audioLevelBuffer) sum += val * val;
			const rms = Math.sqrt(sum / this._audioLevelBuffer.length);
			this.emit('audiolevel', Math.min(1, rms));
		}, intervalMs);

		this.options.logger?.debug('Audio level monitor started', { intervalMs });
	}

	/**
	 * Stop the audio level monitor started by `startAudioLevelMonitor()`.
	 *
	 * Clears the polling timer and closes the underlying `AudioContext`.
	 * Safe to call when monitoring is not active.
	 */
	stopAudioLevelMonitor(): void {
		if (this._audioMonitorTimer !== null) {
			clearInterval(this._audioMonitorTimer);
			this._audioMonitorTimer = null;
		}
		this._audioContext?.close().catch(() => {});
		this._audioContext = null;
		this._audioAnalyser = null;
		this._audioLevelBuffer = null;
	}

	/**
	 * Poll `getStats()` on a fixed interval and invoke `callback` with each
	 * snapshot and a rolling history window. Returns a cleanup function that
	 * stops the polling when called.
	 *
	 * @example
	 * ```ts
	 * const stop = client.watchStats(2_000, (stats, history) => {
	 *   console.log('bitrate', stats.video?.bitrate);
	 *   console.log('avg bitrate (10s)', history.avgVideoBitrate());
	 *   console.log('delta', stats.video!.bitrate - (history.prev?.video?.bitrate ?? 0));
	 * });
	 * // Later:
	 * stop();
	 * ```
	 *
	 * @param intervalMs  How often to collect stats in milliseconds.
	 * @param callback    Invoked with each `StreamStats` snapshot and the
	 *                    rolling `StatsHistory` window.
	 * @param historySize Maximum number of past snapshots retained in the
	 *                    history window. Defaults to `10`.
	 * @returns A zero-argument cleanup function that cancels polling.
	 */
	watchStats(
		intervalMs: number,
		callback: (stats: StreamStats, history: StatsHistory) => void,
		historySize = 10,
	): () => void {
		const history = new StatsHistoryImpl(historySize);
		const timer = setInterval(() => {
			void this.getStats()
				.then((stats) => {
					history.push(stats);
					callback(stats, history);
				})
				.catch(() => {});
		}, intervalMs);
		return () => clearInterval(timer);
	}

	/**
	 * Replace the active audio or video track on the sender without
	 * re-negotiation. The new track takes effect immediately.
	 *
	 * The stored stream reference used for reconnection is updated
	 * automatically so that future `reconnect()` calls use the new track.
	 *
	 * @param kind  `'audio'` or `'video'`.
	 * @param track The replacement `MediaStreamTrack`.
	 *
	 * @throws {InvalidStateError} When there is no active sender for the given kind.
	 */
	async replaceTrack(kind: 'audio' | 'video', track: MediaStreamTrack): Promise<void> {
		if (!this.pc) throw new InvalidStateError('No active peer connection');

		const sender = this.pc.getSenders().find((s) => s.track?.kind === kind);
		if (!sender) throw new InvalidStateError(`No active ${kind} sender`);

		await sender.replaceTrack(track);

		// Apply content hint from options
		const hint =
			kind === 'audio'
				? this.whipOptions.audio?.contentHint
				: Array.isArray(this.whipOptions.video)
					? this.whipOptions.video[0]?.contentHint
					: this.whipOptions.video?.contentHint;
		if (hint !== undefined) track.contentHint = hint;

		// Keep _lastStream in sync so reconnect() uses the new track
		if (this._lastStream) {
			const old =
				kind === 'audio'
					? this._lastStream.getAudioTracks()
					: this._lastStream.getVideoTracks();
			for (const t of old) this._lastStream.removeTrack(t);
			this._lastStream.addTrack(track);
		}

		this.options.logger?.debug('Track replaced', { kind });
	}

	/**
	 * Collect a normalised statistics snapshot from the active
	 * `RTCPeerConnection`. Bitrate values are computed as a delta since the
	 * previous `getStats()` call.
	 *
	 * @throws {InvalidStateError} When no active peer connection exists.
	 */
	async getStats(): Promise<StreamStats> {
		if (!this.pc) throw new InvalidStateError('No active peer connection');

		const report = await this.pc.getStats();
		const now = Date.now();

		let audioBytesSent = 0;
		let videoBytesSent = 0;
		let audioPacketsSent = 0;
		let videoPacketsSent = 0;
		let audioPacketsLost = 0;
		let videoPacketsLost = 0;
		let audioJitter = 0;
		let frameRate = 0;
		let frameWidth = 0;
		let frameHeight = 0;
		let roundTripTime: number | null = null;
		let bestVideoLayerBytes = 0;

		for (const stat of report.values()) {
			if (stat.type === 'outbound-rtp') {
				const s = stat as RTCOutboundRtpStreamStats & {
					framesPerSecond?: number;
					frameWidth?: number;
					frameHeight?: number;
				};
				if (s.kind === 'audio') {
					audioBytesSent += s.bytesSent ?? 0;
					audioPacketsSent += s.packetsSent ?? 0;
				} else if (s.kind === 'video') {
					// Accumulate across simulcast layers
					const layerBytes = s.bytesSent ?? 0;
					videoBytesSent += layerBytes;
					videoPacketsSent += s.packetsSent ?? 0;
					// Use frame stats from the most active (highest-bitrate) layer
					if (layerBytes > bestVideoLayerBytes) {
						bestVideoLayerBytes = layerBytes;
						frameRate = s.framesPerSecond ?? 0;
						frameWidth = s.frameWidth ?? 0;
						frameHeight = s.frameHeight ?? 0;
					}
				}
			}
			if (stat.type === 'remote-inbound-rtp') {
				const s = stat as RTCInboundRtpStreamStats & { roundTripTime?: number };
				if (s.kind === 'audio') {
					audioPacketsLost += s.packetsLost ?? 0;
					audioJitter = s.jitter ?? 0;
				} else if (s.kind === 'video') {
					// Accumulate lost packets across simulcast layers
					videoPacketsLost += s.packetsLost ?? 0;
					if (s.roundTripTime !== undefined) roundTripTime = s.roundTripTime;
				}
			}
		}

		const prev = this._statsSnapshot;
		const elapsed = prev ? (now - prev.timestamp) / 1000 : 0;

		const audioBitrate =
			prev && elapsed > 0 ? ((audioBytesSent - prev.audioBytes) * 8) / elapsed : 0;
		const videoBitrate =
			prev && elapsed > 0 ? ((videoBytesSent - prev.videoBytes) * 8) / elapsed : 0;

		this._statsSnapshot = {
			timestamp: now,
			audioBytes: audioBytesSent,
			videoBytes: videoBytesSent,
		};

		const totalAudio = audioPacketsSent + audioPacketsLost;
		const totalVideo = videoPacketsSent + videoPacketsLost;

		const audio: AudioStats = {
			bitrate: Math.max(0, audioBitrate),
			packetsLost: audioPacketsLost,
			packetsLostRate: totalAudio > 0 ? audioPacketsLost / totalAudio : 0,
			jitter: audioJitter,
		};
		const video: VideoStats = {
			bitrate: Math.max(0, videoBitrate),
			packetsLost: videoPacketsLost,
			packetsLostRate: totalVideo > 0 ? videoPacketsLost / totalVideo : 0,
			frameRate,
			width: frameWidth,
			height: frameHeight,
		};

		const lossRate = Math.max(audio.packetsLostRate, video.packetsLostRate);

		return {
			timestamp: now,
			audio: audioBytesSent > 0 ? audio : null,
			video: videoBytesSent > 0 ? video : null,
			roundTripTime,
			quality: computeQuality(lossRate, roundTripTime),
		};
	}

	// -------------------------------------------------------------------------
	// Transceiver setup
	// -------------------------------------------------------------------------

	private addAudioTransceiver(pc: RTCPeerConnection, stream: MediaStream): void {
		const track = stream.getAudioTracks()[0];
		if (!track) return;

		const contentHint = this.whipOptions.audio?.contentHint;
		if (contentHint !== undefined) track.contentHint = contentHint;

		pc.addTransceiver(track, { direction: 'sendonly' });
	}

	private addVideoTransceiver(
		pc: RTCPeerConnection,
		stream: MediaStream,
		useSimulcast: boolean,
	): void {
		const track = stream.getVideoTracks()[0];
		if (!track) return;

		const videoOpts = this.whipOptions.video;
		const contentHint = Array.isArray(videoOpts)
			? videoOpts[0]?.contentHint
			: videoOpts?.contentHint;
		if (contentHint !== undefined) track.contentHint = contentHint;

		const sendEncodings = useSimulcast
			? this.buildSimulcastEncodings()
			: this.buildSingleEncoding();

		pc.addTransceiver(track, { direction: 'sendonly', sendEncodings });
	}

	private buildSimulcastEncodings(): RTCRtpEncodingParameters[] {
		const videoOpts = this.whipOptions.video;
		const layers = Array.isArray(videoOpts) ? videoOpts : DEFAULT_SIMULCAST_LAYERS;
		return layers.map(toRtcEncoding);
	}

	private buildSingleEncoding(): RTCRtpEncodingParameters[] {
		const videoOpts = this.whipOptions.video;
		if (!videoOpts || Array.isArray(videoOpts)) return [{ active: true }];
		return [toRtcEncoding(videoOpts)];
	}

	// -------------------------------------------------------------------------
	// SDP mutations
	// -------------------------------------------------------------------------

	private mutateSdpOffer(sdp: string, useSimulcast: boolean): string {
		let result = sdp;

		if (this.whipOptions.audioCodec)
			result = preferCodec(result, 'audio', this.whipOptions.audioCodec);
		if (this.whipOptions.videoCodec)
			result = preferCodec(result, 'video', this.whipOptions.videoCodec);
		if (useSimulcast) result = addSimulcast(result);
		if (this.whipOptions.maxBandwidth && this.whipOptions.maxBandwidth > 0)
			result = setBandwidth(result, 'session', this.whipOptions.maxBandwidth);

		const audioEnc = this.whipOptions.audio;
		if (audioEnc) {
			const fmtpParams = buildOpusFmtp(audioEnc);
			if (Object.keys(fmtpParams).length > 0)
				result = patchFmtp(result, 'audio', 'opus', fmtpParams);
		}

		return result;
	}

	// -------------------------------------------------------------------------
	// Post-negotiation constraints
	// -------------------------------------------------------------------------

	/**
	 * Apply bitrate and degradation-preference constraints via
	 * `RTCRtpSender.setParameters()` after `setRemoteDescription`.
	 */
	private async applyEncodingConstraints(pc: RTCPeerConnection): Promise<void> {
		for (const sender of pc.getSenders()) {
			if (!sender.track) continue;
			await (sender.track.kind === 'audio'
				? this.applyAudioConstraints(sender)
				: this.applyVideoConstraints(sender));
		}
	}

	private async applyAudioConstraints(sender: RTCRtpSender): Promise<void> {
		const audioOpts = this.whipOptions.audio;
		if (!audioOpts?.maxBitrate) return;

		const params = sender.getParameters();
		if (!params.encodings?.length) return;

		for (const enc of params.encodings) enc.maxBitrate = audioOpts.maxBitrate;

		await sender.setParameters(params).catch(() => {
			// setParameters can fail if the connection is not yet fully established
		});
	}

	private async applyVideoConstraints(sender: RTCRtpSender): Promise<void> {
		const videoOpts = this.whipOptions.video;
		if (!videoOpts) return;

		const params = sender.getParameters();
		if (!params.encodings?.length) return;

		if (Array.isArray(videoOpts)) {
			for (const enc of params.encodings) {
				const layerOpts = videoOpts.find((l) => l.rid === enc.rid) ?? videoOpts[0];
				if (layerOpts) applyLayerToEncoding(enc, layerOpts);
			}
		} else {
			for (const enc of params.encodings) applyLayerToEncoding(enc, videoOpts);
		}

		await sender.setParameters(params).catch(() => {
			// Best-effort
		});
	}

	// -------------------------------------------------------------------------
	// Reconnect internals
	// -------------------------------------------------------------------------

	protected override onBeforeTeardown(): void {
		this.cleanupIce?.();
		this.cleanupIce = null;
		this.stopAdaptiveQuality();
		this.stopAudioLevelMonitor();
	}

	private async _doReconnect(): Promise<void> {
		const useRecovery = this.whipOptions.endpointRecovery ?? false;

		if (useRecovery && this.resourceUrl && this.etag) {
			try {
				this.options.logger?.info('Attempting endpoint recovery via PATCH (RFC 9725 §4.3)');
				await this._tryEndpointRecovery();
				this._statsSnapshot = null;
				return;
			} catch (err) {
				this.options.logger?.warn(
					'Endpoint recovery failed, falling back to full reconnect',
					{ error: err instanceof Error ? err.message : String(err) },
				);
				// Close any partial new PC and delete the server resource
				this.pc?.close();
				this.pc = null;
				await this.deleteResource();
			}
		}

		await this.teardownForReconnect();
		this.setState('idle');
		this._statsSnapshot = null;
		await this.publish(this._lastStream!, this._lastPublishOptions);
	}

	/**
	 * Attempt to recover the WHIP session by sending a new SDP offer to the
	 * existing resource URL via HTTP PATCH (RFC 9725 §4.3).
	 *
	 * Creates a fresh `RTCPeerConnection`, generates a new offer, and PATCHes
	 * the resource with `If-Match: <etag>`. If the server responds with
	 * `200 OK`, the new answer is applied and ICE proceeds normally.
	 *
	 * The server resource is **not** deleted before the attempt, preserving
	 * the session for potential recovery.
	 *
	 * @throws When the PATCH is rejected or the connection fails to establish.
	 */
	private async _tryEndpointRecovery(): Promise<void> {
		this.teardownPcOnly(); // close old PC, keep resourceUrl + etag
		this.setState('connecting');

		const pc = this.createPeerConnection();
		const { audio = true, video = true } = this._lastPublishOptions;
		const useSimulcast =
			this._lastPublishOptions.simulcast ?? this.whipOptions.simulcast ?? false;

		if (audio) this.addAudioTransceiver(pc, this._lastStream!);
		if (video) this.addVideoTransceiver(pc, this._lastStream!, useSimulcast);

		const offer = await pc.createOffer();
		const sdp = this.mutateSdpOffer(offer.sdp ?? '', useSimulcast);
		await pc.setLocalDescription({ type: 'offer', sdp });

		const sdpAnswer = await this.patchSdpForIceRestart(sdp).catch((err) => {
			throw err instanceof WHIPError
				? err
				: new WHIPError('ICE restart PATCH failed', { cause: err });
		});

		await pc.setRemoteDescription({ type: 'answer', sdp: sdpAnswer });
		await this.applyEncodingConstraints(pc);
		await this.waitForIceConnection(pc);

		this.cleanupIce = setupIceTrickle(pc, {
			mode: 'end-of-candidates',
			onCandidates: (candidates) => this.patchIceCandidates(candidates),
		});

		this.startAdaptiveQuality();
	}

	// -------------------------------------------------------------------------
	// Adaptive quality
	// -------------------------------------------------------------------------

	private startAdaptiveQuality(): void {
		const opts = this.resolveAdaptiveQuality();
		if (!opts) return;

		this._targetBitrate = this.getTargetBitrate();
		this._currentAdaptiveQuality = 'excellent';
		this._degradedCount = 0;
		this._improvedCount = 0;

		this._adaptiveTimer = setInterval(() => {
			void this._adaptStep(opts);
		}, opts.intervalMs);
	}

	private stopAdaptiveQuality(): void {
		if (this._adaptiveTimer !== null) {
			clearInterval(this._adaptiveTimer);
			this._adaptiveTimer = null;
		}
	}

	private async _adaptStep(opts: Required<AdaptiveQualityOptions>): Promise<void> {
		if (!this.pc) return;

		let stats: StreamStats;
		try {
			stats = await this.getStats();
		} catch {
			return;
		}

		const measured = stats.quality;
		const current = this._currentAdaptiveQuality;

		if (QUALITY_RANK[measured] < QUALITY_RANK[current]) {
			this._degradedCount++;
			this._improvedCount = 0;
			if (this._degradedCount >= opts.downgradeThreshold) {
				this._degradedCount = 0;
				this._currentAdaptiveQuality = measured;
				await this._applyQualityBitrate(measured, opts);
				this.options.logger?.info('Adaptive quality: downgraded', { quality: measured });
				this.emit('qualitychange', measured);
			}
		} else if (QUALITY_RANK[measured] > QUALITY_RANK[current]) {
			this._improvedCount++;
			this._degradedCount = 0;
			if (this._improvedCount >= opts.upgradeThreshold) {
				this._improvedCount = 0;
				this._currentAdaptiveQuality = measured;
				await this._applyQualityBitrate(measured, opts);
				this.options.logger?.info('Adaptive quality: upgraded', { quality: measured });
				this.emit('qualitychange', measured);
			}
		} else {
			this._degradedCount = 0;
			this._improvedCount = 0;
		}
	}

	/**
	 * Apply the bitrate target for the given quality level to the active
	 * video sender via `RTCRtpSender.setParameters()`.
	 */
	private async _applyQualityBitrate(
		quality: ConnectionQuality,
		opts: Required<AdaptiveQualityOptions>,
	): Promise<void> {
		if (!this.pc || !this._targetBitrate) return;

		const factor = QUALITY_FACTORS[quality];
		const targetBitrate = Math.max(
			opts.minVideoBitrate,
			Math.round(this._targetBitrate * factor),
		);

		for (const sender of this.pc.getSenders()) {
			if (sender.track?.kind !== 'video') continue;
			const params = sender.getParameters();
			if (!params.encodings?.length) continue;
			for (const enc of params.encodings) enc.maxBitrate = targetBitrate;
			await sender.setParameters(params).catch(() => {});
			this.options.logger?.debug('Adaptive quality: video bitrate adjusted', {
				quality,
				targetBitrate,
			});
			break; // Only the first video sender
		}
	}

	/** Determine the baseline video bitrate for adaptive quality scaling. */
	private getTargetBitrate(): number {
		const videoOpts = this.whipOptions.video;
		if (videoOpts && !Array.isArray(videoOpts) && videoOpts.maxBitrate) {
			return videoOpts.maxBitrate;
		}
		return 2_500_000; // 2.5 Mbps default
	}

	private resolveAdaptiveQuality(): Required<AdaptiveQualityOptions> | null {
		const raw = this.whipOptions.adaptiveQuality;
		if (!raw) return null;
		const opts = typeof raw === 'boolean' ? {} : raw;
		return {
			intervalMs: opts.intervalMs ?? 5_000,
			downgradeThreshold: opts.downgradeThreshold ?? 2,
			upgradeThreshold: opts.upgradeThreshold ?? 4,
			minVideoBitrate: opts.minVideoBitrate ?? 150_000,
		};
	}
}
