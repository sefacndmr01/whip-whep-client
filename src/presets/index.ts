import type { WHIPClientOptions, WHEPClientOptions } from '../core/types.js';

/**
 * A partial options object that can be spread into `WHIPClient` or
 * `WHEPClient` constructors. The `endpoint` field is intentionally excluded
 * because it is always server-instance-specific.
 */
export type WHIPPreset = Omit<WHIPClientOptions, 'endpoint'>;
export type WHEPPreset = Omit<WHEPClientOptions, 'endpoint'>;

// ---------------------------------------------------------------------------
// LiveKit
// ---------------------------------------------------------------------------

/**
 * Presets for LiveKit Cloud and self-hosted LiveKit Server.
 *
 * LiveKit uses standard WHIP/WHEP signalling. Tokens are LiveKit Access
 * Tokens (JWTs) generated server-side via the LiveKit Server SDK.
 *
 * Endpoint formats:
 * - WHIP: `https://<project>.livekit.cloud/rtc/whip`
 * - WHEP: `https://<project>.livekit.cloud/rtc/whep`
 *
 * @see https://docs.livekit.io/realtime/ingress/whip/
 * @see https://docs.livekit.io/realtime/egress/whep/
 */
export const livekit = {
	/**
	 * Recommended options for publishing to a LiveKit WHIP endpoint.
	 *
	 * @param token LiveKit Access Token (JWT).
	 */
	whip(token: string): WHIPPreset {
		return {
			token,
			videoCodec: 'h264',
			simulcast: true,
			audio: {
				dtx: true,
				fec: true,
				contentHint: 'speech',
			},
		};
	},

	/**
	 * Recommended options for viewing from a LiveKit WHEP endpoint.
	 *
	 * @param token LiveKit Access Token (JWT).
	 */
	whep(token: string): WHEPPreset {
		return {
			token,
			videoCodec: 'h264',
		};
	},
};

// ---------------------------------------------------------------------------
// OvenMedia Engine
// ---------------------------------------------------------------------------

/**
 * Presets for OvenMediaEngine (OME).
 *
 * OME exposes WHIP and WHEP on separate ports by default:
 * - WHIP port: `3333`  (WebRTC Push)
 * - WHEP port: `3334`  (WebRTC Pull)
 *
 * Endpoint formats:
 * - WHIP: `http://<host>:3333/<app>/<stream>`
 * - WHEP: `http://<host>:3334/<app>/<stream>`
 *
 * Authentication is optional and configured per-application in
 * `Server.xml`. When enabled, pass the signed policy token via `token`.
 *
 * @see https://airensoft.gitbook.io/ovenmediaengine/live-source/whip
 * @see https://airensoft.gitbook.io/ovenmediaengine/streaming/webrtc-publishing
 */
export const ovenmedia = {
	/**
	 * Recommended options for publishing to an OvenMedia Engine WHIP endpoint.
	 *
	 * @param token Signed policy token (omit when access control is disabled).
	 */
	whip(token?: string): WHIPPreset {
		return {
			...(token && { token }),
			videoCodec: 'h264',
			audio: {
				fec: true,
			},
		};
	},

	/**
	 * Recommended options for viewing from an OvenMedia Engine WHEP endpoint.
	 *
	 * @param token Signed policy token (omit when access control is disabled).
	 */
	whep(token?: string): WHEPPreset {
		return {
			...(token && { token }),
			videoCodec: 'h264',
		};
	},
};

// ---------------------------------------------------------------------------
// Cloudflare Stream
// ---------------------------------------------------------------------------

/**
 * Presets for Cloudflare Stream WebRTC (WHIP ingest).
 *
 * The authentication key is embedded in the endpoint URL; no separate
 * `Authorization` header is needed. H.264 is required.
 *
 * Endpoint format:
 * - WHIP: `https://customer-<uid>.cloudflarestream.com/<live-input-key>/webrtc/publish`
 * - WHEP: `https://customer-<uid>.cloudflarestream.com/<live-input-key>/webrtc/play`
 *
 * The `<live-input-key>` is obtained when creating a Live Input via the
 * Cloudflare Stream API or dashboard.
 *
 * @see https://developers.cloudflare.com/stream/webrtc-beta/
 */
export const cloudflare = {
	/**
	 * Recommended options for publishing to Cloudflare Stream via WHIP.
	 *
	 * Authentication is handled through the endpoint URL; no token is needed.
	 */
	whip(): WHIPPreset {
		return {
			videoCodec: 'h264',
			audio: {
				maxBitrate: 128_000,
				dtx: true,
			},
		};
	},

	/**
	 * Recommended options for viewing from Cloudflare Stream via WHEP.
	 */
	whep(): WHEPPreset {
		return {
			videoCodec: 'h264',
		};
	},
};

// ---------------------------------------------------------------------------
// Millicast (Dolby.io Real-time Streaming)
// ---------------------------------------------------------------------------

/**
 * Presets for Millicast (Dolby.io Real-time Streaming).
 *
 * Millicast is a managed WebRTC CDN with global delivery via WHIP ingest
 * and WHEP egress. Authentication uses Bearer tokens issued by the Millicast
 * Director API — never embed long-lived tokens in client code.
 *
 * Endpoint formats:
 * - WHIP: `https://director.millicast.com/api/whip/<streamName>`
 * - WHEP: `https://director.millicast.com/api/whep/<streamName>`
 *
 * @see https://docs.dolby.io/streaming-apis/docs/whip
 * @see https://docs.dolby.io/streaming-apis/docs/whep
 */
export const millicast = {
	/**
	 * Recommended options for publishing to Millicast via WHIP.
	 *
	 * @param token Short-lived publish token obtained from the Millicast Director API.
	 */
	whip(token: string): WHIPPreset {
		return {
			token,
			videoCodec: 'h264',
			audio: {
				dtx: true,
				fec: true,
				stereo: true,
			},
		};
	},

	/**
	 * Recommended options for viewing from Millicast via WHEP.
	 *
	 * @param token Short-lived subscribe token obtained from the Millicast Director API.
	 */
	whep(token: string): WHEPPreset {
		return {
			token,
			videoCodec: 'h264',
		};
	},
};

// ---------------------------------------------------------------------------
// SRS (Simple Realtime Server)
// ---------------------------------------------------------------------------

/**
 * Presets for SRS (Simple Realtime Server).
 *
 * SRS is a popular open-source media server with native WHIP and WHEP
 * support. By default no authentication is required; to enable it, set
 * `http_hooks` or `security` in `srs.conf` and pass the generated token.
 *
 * Endpoint formats:
 * - WHIP: `http://<host>:1985/rtc/v1/whip/?app=<app>&stream=<streamName>`
 * - WHEP: `http://<host>:1985/rtc/v1/whep/?app=<app>&stream=<streamName>`
 *
 * @see https://ossrs.io/lts/en-us/docs/v6/doc/whip
 */
export const srs = {
	/**
	 * Recommended options for publishing to SRS via WHIP.
	 *
	 * @param token Auth token (omit when SRS security hooks are disabled).
	 */
	whip(token?: string): WHIPPreset {
		return {
			...(token && { token }),
			videoCodec: 'h264',
			audio: {
				fec: true,
			},
		};
	},

	/**
	 * Recommended options for viewing from SRS via WHEP.
	 *
	 * @param token Auth token (omit when SRS security hooks are disabled).
	 */
	whep(token?: string): WHEPPreset {
		return {
			...(token && { token }),
			videoCodec: 'h264',
		};
	},
};

// ---------------------------------------------------------------------------
// MediaMTX
// ---------------------------------------------------------------------------

/**
 * Presets for MediaMTX (formerly rtsp-simple-server).
 *
 * MediaMTX is a lightweight, zero-dependency media server that supports
 * WHIP and WHEP out of the box. Authentication is optional and configured
 * via `mediamtx.yml`; when enabled, pass the credentials as a Bearer token.
 *
 * Endpoint formats:
 * - WHIP: `http://<host>:8889/<pathName>/whip`
 * - WHEP: `http://<host>:8889/<pathName>/whep`
 *
 * @see https://github.com/bluenviron/mediamtx#webrtc
 */
export const mediamtx = {
	/**
	 * Recommended options for publishing to MediaMTX via WHIP.
	 *
	 * @param token Internal authentication token (omit when auth is disabled).
	 */
	whip(token?: string): WHIPPreset {
		return {
			...(token && { token }),
			videoCodec: 'h264',
			audio: {
				fec: true,
				dtx: true,
			},
		};
	},

	/**
	 * Recommended options for viewing from MediaMTX via WHEP.
	 *
	 * @param token Internal authentication token (omit when auth is disabled).
	 */
	whep(token?: string): WHEPPreset {
		return {
			...(token && { token }),
			videoCodec: 'h264',
		};
	},
};

// ---------------------------------------------------------------------------
// Ant Media Server
// ---------------------------------------------------------------------------

/**
 * Presets for Ant Media Server (AMS) Community and Enterprise editions.
 *
 * Endpoint formats:
 * - WHIP: `http://<host>:5080/<app>/whip/<streamId>`
 * - WHEP: `http://<host>:5080/<app>/whep/<streamId>`
 *
 * Enterprise edition supports HTTPS and JWT-based authentication.
 * The token, when required, is passed as a Bearer token.
 *
 * @see https://antmedia.io/docs/guides/publish-live-stream/WebRTC/webrtc-whip/
 * @see https://antmedia.io/docs/guides/playing-live-stream/WebRTC/webrtc-whep/
 */
export const antmedia = {
	/**
	 * Recommended options for publishing to Ant Media Server via WHIP.
	 *
	 * @param token JWT subscriber token (omit when authentication is disabled).
	 */
	whip(token?: string): WHIPPreset {
		return {
			...(token && { token }),
			videoCodec: 'h264',
			audio: {
				fec: true,
			},
		};
	},

	/**
	 * Recommended options for viewing from Ant Media Server via WHEP.
	 *
	 * @param token JWT subscriber token (omit when authentication is disabled).
	 */
	whep(token?: string): WHEPPreset {
		return {
			...(token && { token }),
			videoCodec: 'h264',
		};
	},
};
