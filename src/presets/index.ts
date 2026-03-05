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
