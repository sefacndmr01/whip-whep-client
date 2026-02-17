import { BaseClient } from '../core/BaseClient.js';
import type {
	WHIPClientOptions,
	WHIPClientEvents,
	PublishOptions,
	AudioEncodingOptions,
	VideoLayerOptions,
	StreamStats,
	AudioStats,
	VideoStats,
} from '../core/types.js';
import { WHIPError, InvalidStateError } from '../core/errors.js';
import { preferCodec, addSimulcast, setBandwidth, patchFmtp } from '../utils/sdp.js';
import { setupIceTrickle } from '../utils/ice.js';
import { computeQuality } from '../utils/stats.js';

// ---------------------------------------------------------------------------
// Constants – default simulcast layer configuration
// ---------------------------------------------------------------------------

const DEFAULT_SIMULCAST_LAYERS: VideoLayerOptions[] = [
	{ rid: 'high', active: true, maxBitrate: 2_500_000, scaleResolutionDownBy: 1 },
	{ rid: 'mid', active: true, maxBitrate: 1_000_000, scaleResolutionDownBy: 2 },
	{ rid: 'low', active: true, maxBitrate: 300_000, scaleResolutionDownBy: 4 },
];

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
	private _statsSnapshot: { timestamp: number; audioBytes: number; videoBytes: number } | null =
		null;

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

		const { audio = true, video = true } = options;
		const useSimulcast = options.simulcast ?? this.whipOptions.simulcast ?? false;

		this.options.logger?.info('Publishing stream', { audio, video, simulcast: useSimulcast });

		try {
			const pc = this.createPeerConnection();

			if (audio) this.addAudioTransceiver(pc, stream);
			if (video) this.addVideoTransceiver(pc, stream, useSimulcast);

			const offer = await pc.createOffer();
			const sdp = this.mutateSdpOffer(offer.sdp ?? '', useSimulcast);

			await pc.setLocalDescription({ type: 'offer', sdp });

			const { sdpAnswer, resourceUrl } = await this.postSdpOffer(sdp).catch((err) => {
				throw err instanceof WHIPError
					? err
					: new WHIPError('Failed to exchange SDP with WHIP endpoint', { cause: err });
			});

			this.resourceUrl = resourceUrl;
			await pc.setRemoteDescription({ type: 'answer', sdp: sdpAnswer });

			await this.applyEncodingConstraints(pc);
			await this.waitForIceConnection(pc);

			this.cleanupIce = setupIceTrickle(pc, {
				mode: 'end-of-candidates',
				onCandidates: (candidates) => this.patchIceCandidates(candidates),
			});
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

		for (const stat of report.values()) {
			if (stat.type === 'outbound-rtp') {
				const s = stat as RTCOutboundRtpStreamStats & {
					framesPerSecond?: number;
					frameWidth?: number;
					frameHeight?: number;
				};
				if (s.kind === 'audio') {
					audioBytesSent = s.bytesSent ?? 0;
					audioPacketsSent = s.packetsSent ?? 0;
				} else if (s.kind === 'video') {
					videoBytesSent = s.bytesSent ?? 0;
					videoPacketsSent = s.packetsSent ?? 0;
					frameRate = s.framesPerSecond ?? 0;
					frameWidth = s.frameWidth ?? 0;
					frameHeight = s.frameHeight ?? 0;
				}
			}
			if (stat.type === 'remote-inbound-rtp') {
				const s = stat as RTCInboundRtpStreamStats & { roundTripTime?: number };
				if (s.kind === 'audio') {
					audioPacketsLost = s.packetsLost ?? 0;
					audioJitter = s.jitter ?? 0;
				} else if (s.kind === 'video') {
					videoPacketsLost = s.packetsLost ?? 0;
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
		return layers.map((layer) => toRtcEncoding(layer));
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

		// Opus fmtp parameters
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
	 *
	 * This is more reliable than SDP munging for per-sender limits because
	 * it does not require re-negotiation and is supported by all major
	 * browsers.
	 */
	private async applyEncodingConstraints(pc: RTCPeerConnection): Promise<void> {
		for (const sender of pc.getSenders()) {
			if (!sender.track) continue;

			const isAudio = sender.track.kind === 'audio';
			await (isAudio
				? this.applyAudioConstraints(sender)
				: this.applyVideoConstraints(sender));
		}
	}

	private async applyAudioConstraints(sender: RTCRtpSender): Promise<void> {
		const audioOpts = this.whipOptions.audio;
		if (!audioOpts?.maxBitrate) return;

		const params = sender.getParameters();
		if (!params.encodings?.length) return;

		for (const enc of params.encodings) {
			enc.maxBitrate = audioOpts.maxBitrate;
		}

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
				if (!layerOpts) continue;
				applyLayerToEncoding(enc, layerOpts);
			}
		} else {
			for (const enc of params.encodings) {
				applyLayerToEncoding(enc, videoOpts);
			}
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
	}

	private async _doReconnect(): Promise<void> {
		await this.teardownForReconnect();
		this.setState('idle');
		this._statsSnapshot = null;
		await this.publish(this._lastStream!, this._lastPublishOptions);
	}
}

// ---------------------------------------------------------------------------
// Module-private helpers
// ---------------------------------------------------------------------------

function toRtcEncoding(layer: VideoLayerOptions): RTCRtpEncodingParameters {
	const enc: RTCRtpEncodingParameters = { active: layer.active ?? true };

	if (layer.rid !== undefined) enc.rid = layer.rid;
	if (layer.maxBitrate !== undefined) enc.maxBitrate = layer.maxBitrate;
	if (layer.maxFramerate !== undefined) enc.maxFramerate = layer.maxFramerate;
	if (layer.scaleResolutionDownBy !== undefined)
		enc.scaleResolutionDownBy = layer.scaleResolutionDownBy;

	// `degradationPreference` was removed from the per-encoding spec and is
	// not present in current TypeScript DOM types. It is kept in
	// `VideoLayerOptions` for forward-compatibility but not applied here.

	return enc;
}

function applyLayerToEncoding(enc: RTCRtpEncodingParameters, layer: VideoLayerOptions): void {
	if (layer.maxBitrate !== undefined) enc.maxBitrate = layer.maxBitrate;
	if (layer.maxFramerate !== undefined) enc.maxFramerate = layer.maxFramerate;
	if (layer.scaleResolutionDownBy !== undefined)
		enc.scaleResolutionDownBy = layer.scaleResolutionDownBy;
	if (layer.active !== undefined) enc.active = layer.active;
}

function buildOpusFmtp(opts: AudioEncodingOptions): Record<string, string | number> {
	const params: Record<string, string | number> = {};

	if (opts.dtx === true) params['usedtx'] = 1;
	if (opts.stereo === true) params['stereo'] = 1;
	if (opts.fec === false) params['useinbandfec'] = 0;
	if (opts.fec === true) params['useinbandfec'] = 1;
	if (opts.comfortNoise === true) params['usecn'] = 1;

	return params;
}
