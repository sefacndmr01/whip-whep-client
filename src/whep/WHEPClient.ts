import { BaseClient } from '../core/BaseClient.js';
import type {
	WHEPClientOptions,
	WHEPClientEvents,
	ViewOptions,
	StreamStats,
	AudioStats,
	VideoStats,
} from '../core/types.js';
import { WHEPError, InvalidStateError } from '../core/errors.js';
import { preferCodec, setBandwidth } from '../utils/sdp.js';
import { setupIceTrickle } from '../utils/ice.js';
import { computeQuality, type StatsSnapshot } from '../utils/stats.js';

/**
 * WHEP (WebRTC-HTTP Egress Protocol) client.
 *
 * Subscribes to a live media stream from a WHEP-compatible server using a
 * single SDP offer/answer exchange over HTTP POST, followed by an optional
 * trickle-ICE exchange via HTTP PATCH.
 *
 * ### Minimal usage
 *
 * ```ts
 * const client = new WHEPClient({ endpoint: 'https://cdn.example.com/whep/stream123' });
 *
 * client.on('stream', (stream) => { videoEl.srcObject = stream; });
 *
 * await client.view();
 * // …
 * await client.stop();
 * ```
 *
 * ### Advanced usage
 *
 * ```ts
 * const client = new WHEPClient({
 *   endpoint: 'https://cdn.example.com/whep/stream123',
 *   token: 'viewer-token',
 *   videoCodec: 'h264',
 *   maxBandwidth: 2_500,   // hint server to send ≤2.5 Mbps
 * });
 * ```
 */
export class WHEPClient extends BaseClient<WHEPClientEvents> {
	private readonly whepOptions: WHEPClientOptions;
	private cleanupIce: (() => void) | null = null;

	private _lastViewOptions: ViewOptions = {};
	private _statsSnapshot: StatsSnapshot | null = null;

	constructor(options: WHEPClientOptions) {
		super(options);
		this.whepOptions = options;

		if (options.autoReconnect) {
			this.on('failed', () => {
				if (this._wasConnected) {
					this._wasConnected = false;
					const token = this._reconnectToken;
					void this.scheduleReconnect(() => this._doReconnect(), token);
				}
			});
		}
	}

	// -------------------------------------------------------------------------
	// Public API
	// -------------------------------------------------------------------------

	/**
	 * Start receiving the remote stream from the WHEP endpoint.
	 *
	 * Steps performed:
	 * 1. Create `RTCPeerConnection`
	 * 2. Add `recvonly` transceivers for audio and/or video
	 * 3. Munge SDP (codec order, bandwidth hint)
	 * 4. `POST` offer → receive answer → `setRemoteDescription`
	 * 5. Wait for ICE connection (when `iceConnectionTimeout` is set)
	 * 6. Start trickle-ICE PATCH in the background
	 *
	 * The returned `MediaStream` is populated with tracks as they arrive via
	 * `ontrack`. The `'stream'` event fires once all expected tracks have been
	 * received, making it safe to assign directly to `videoEl.srcObject`.
	 *
	 * @param options Per-call control over which media types to receive.
	 * @returns A `MediaStream` that will be populated as remote tracks arrive.
	 *
	 * @throws {WHEPError}         On server rejection or network error.
	 * @throws {TimeoutError}      When the SDP or ICE exchange exceeds its timeout.
	 * @throws {InvalidStateError} When `view()` is called on a non-idle client.
	 */
	async view(options: ViewOptions = {}): Promise<MediaStream> {
		this.assertIdle('view');
		this.setState('connecting');

		this._lastViewOptions = options;
		this._statsSnapshot = null;

		const { audio = true, video = true } = options;
		const expectedTracks = (audio ? 1 : 0) + (video ? 1 : 0);
		let receivedTracks = 0;
		let streamEmitted = false;

		this.options.logger?.info('Viewing stream', { audio, video });

		const stream = new MediaStream();

		try {
			const pc = this.createPeerConnection();

			if (audio) pc.addTransceiver('audio', { direction: 'recvonly' });
			if (video) pc.addTransceiver('video', { direction: 'recvonly' });

			pc.addEventListener('track', (event: RTCTrackEvent) => {
				stream.addTrack(event.track);
				receivedTracks++;
				if (!streamEmitted && receivedTracks >= expectedTracks) {
					streamEmitted = true;
					this.emit('stream', stream);
				}
			});

			const offer = await pc.createOffer();
			const sdp = this.mutateSdpOffer(offer.sdp ?? '');

			await pc.setLocalDescription({ type: 'offer', sdp });

			const { sdpAnswer, resourceUrl } = await this.postSdpOffer(sdp).catch((err) => {
				throw err instanceof WHEPError
					? err
					: new WHEPError('Failed to exchange SDP with WHEP endpoint', { cause: err });
			});

			this.resourceUrl = resourceUrl;
			await pc.setRemoteDescription({ type: 'answer', sdp: sdpAnswer });

			await this.waitForIceConnection(pc);

			this.cleanupIce = setupIceTrickle(pc, {
				mode: 'end-of-candidates',
				onCandidates: (candidates) => this.patchIceCandidates(candidates),
			});

			return stream;
		} catch (err) {
			this.setState('failed');
			await this.deleteResource();
			this.close();
			throw err;
		}
	}

	/**
	 * Stop receiving and release all resources.
	 *
	 * Stops all remote tracks, sends an HTTP DELETE, and closes the peer
	 * connection. Safe to call multiple times.
	 */
	async stop(): Promise<void> {
		if (this.state === 'closed') return;

		this._reconnectToken++;
		this.options.logger?.info('Stopping WHEP client');

		this.cleanupIce?.();
		this.cleanupIce = null;

		if (this.pc) {
			for (const receiver of this.pc.getReceivers()) receiver.track.stop();
		}

		await this.deleteResource();
		this.close();
	}

	/**
	 * Re-establish the WHEP session. Cleans up the current peer connection,
	 * resets internal state, and calls `view()` with the options from the
	 * last `view()` call.
	 *
	 * The new `MediaStream` is delivered via the `'stream'` event.
	 */
	async reconnect(): Promise<void> {
		this._reconnectToken++;
		await this._doReconnect();
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

		let audioBytesReceived = 0;
		let videoBytesReceived = 0;
		let audioPacketsReceived = 0;
		let videoPacketsReceived = 0;
		let audioPacketsLost = 0;
		let videoPacketsLost = 0;
		let audioJitter = 0;
		let frameRate = 0;
		let frameWidth = 0;
		let frameHeight = 0;
		let roundTripTime: number | null = null;

		for (const stat of report.values()) {
			if (stat.type === 'inbound-rtp') {
				const s = stat as RTCInboundRtpStreamStats & {
					framesPerSecond?: number;
					frameWidth?: number;
					frameHeight?: number;
				};
				if (s.kind === 'audio') {
					audioBytesReceived = s.bytesReceived ?? 0;
					audioPacketsReceived = s.packetsReceived ?? 0;
					audioPacketsLost = s.packetsLost ?? 0;
					audioJitter = s.jitter ?? 0;
				} else if (s.kind === 'video') {
					videoBytesReceived = s.bytesReceived ?? 0;
					videoPacketsReceived = s.packetsReceived ?? 0;
					videoPacketsLost = s.packetsLost ?? 0;
					frameRate = s.framesPerSecond ?? 0;
					frameWidth = s.frameWidth ?? 0;
					frameHeight = s.frameHeight ?? 0;
				}
			}
			if (stat.type === 'candidate-pair') {
				const s = stat as RTCIceCandidatePairStats & { nominated?: boolean };
				if (s.currentRoundTripTime !== undefined) {
					// Prefer the nominated (active) pair; fall back to any succeeded pair
					if (s.nominated) roundTripTime = s.currentRoundTripTime;
					else if (s.state === 'succeeded' && roundTripTime === null)
						roundTripTime = s.currentRoundTripTime;
				}
			}
		}

		const prev = this._statsSnapshot;
		const elapsed = prev ? (now - prev.timestamp) / 1000 : 0;

		const audioBitrate =
			prev && elapsed > 0 ? ((audioBytesReceived - prev.audioBytes) * 8) / elapsed : 0;
		const videoBitrate =
			prev && elapsed > 0 ? ((videoBytesReceived - prev.videoBytes) * 8) / elapsed : 0;

		this._statsSnapshot = {
			timestamp: now,
			audioBytes: audioBytesReceived,
			videoBytes: videoBytesReceived,
		};

		const totalAudio = audioPacketsReceived + audioPacketsLost;
		const totalVideo = videoPacketsReceived + videoPacketsLost;

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
			audio: audioBytesReceived > 0 ? audio : null,
			video: videoBytesReceived > 0 ? video : null,
			roundTripTime,
			quality: computeQuality(lossRate, roundTripTime),
		};
	}

	// -------------------------------------------------------------------------
	// SDP mutations
	// -------------------------------------------------------------------------

	private mutateSdpOffer(sdp: string): string {
		let result = sdp;

		if (this.whepOptions.audioCodec)
			result = preferCodec(result, 'audio', this.whepOptions.audioCodec);
		if (this.whepOptions.videoCodec)
			result = preferCodec(result, 'video', this.whepOptions.videoCodec);
		if (this.whepOptions.maxBandwidth && this.whepOptions.maxBandwidth > 0)
			result = setBandwidth(result, 'video', this.whepOptions.maxBandwidth);

		return result;
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
		await this.view(this._lastViewOptions);
	}
}
