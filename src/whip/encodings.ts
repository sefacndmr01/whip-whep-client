import type { AudioEncodingOptions, VideoLayerOptions } from '../core/types.js';

// ---------------------------------------------------------------------------
// Default simulcast layer configuration
// ---------------------------------------------------------------------------

export const DEFAULT_SIMULCAST_LAYERS: VideoLayerOptions[] = [
	{ rid: 'high', active: true, maxBitrate: 2_500_000, scaleResolutionDownBy: 1 },
	{ rid: 'mid', active: true, maxBitrate: 1_000_000, scaleResolutionDownBy: 2 },
	{ rid: 'low', active: true, maxBitrate: 300_000, scaleResolutionDownBy: 4 },
];

// ---------------------------------------------------------------------------
// Encoding parameter builders
// ---------------------------------------------------------------------------

/**
 * Map a `VideoLayerOptions` object to an `RTCRtpEncodingParameters` object
 * understood by `addTransceiver` and `setParameters`.
 */
export const toRtcEncoding = (layer: VideoLayerOptions): RTCRtpEncodingParameters => {
	const enc: RTCRtpEncodingParameters = { active: layer.active ?? true };

	if (layer.rid !== undefined) enc.rid = layer.rid;
	if (layer.maxBitrate !== undefined) enc.maxBitrate = layer.maxBitrate;
	if (layer.maxFramerate !== undefined) enc.maxFramerate = layer.maxFramerate;
	if (layer.scaleResolutionDownBy !== undefined)
		enc.scaleResolutionDownBy = layer.scaleResolutionDownBy;

	// `degradationPreference` was removed from the per-encoding spec; kept in
	// VideoLayerOptions for forward-compatibility but not applied here.

	return enc;
};

/**
 * Merge `VideoLayerOptions` values into an existing `RTCRtpEncodingParameters`
 * entry (used in `setParameters` after negotiation).
 */
export const applyLayerToEncoding = (
	enc: RTCRtpEncodingParameters,
	layer: VideoLayerOptions,
): void => {
	if (layer.maxBitrate !== undefined) enc.maxBitrate = layer.maxBitrate;
	if (layer.maxFramerate !== undefined) enc.maxFramerate = layer.maxFramerate;
	if (layer.scaleResolutionDownBy !== undefined)
		enc.scaleResolutionDownBy = layer.scaleResolutionDownBy;
	if (layer.active !== undefined) enc.active = layer.active;
};

/**
 * Build an `a=fmtp` parameter map for Opus from `AudioEncodingOptions`.
 * Only options that differ from the Opus defaults are included.
 */
export const buildOpusFmtp = (opts: AudioEncodingOptions): Record<string, string | number> => {
	const params: Record<string, string | number> = {};

	if (opts.dtx === true) params['usedtx'] = 1;
	if (opts.stereo === true) params['stereo'] = 1;
	if (opts.fec === false) params['useinbandfec'] = 0;
	if (opts.fec === true) params['useinbandfec'] = 1;
	if (opts.comfortNoise === true) params['usecn'] = 1;

	return params;
};
