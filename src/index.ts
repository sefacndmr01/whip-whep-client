// Clients
export { WHIPClient } from './whip/WHIPClient.js';
export { WHEPClient } from './whep/WHEPClient.js';

// Core – base class and state
export { TypedEventEmitter } from './core/BaseClient.js';
export type { ClientState } from './core/BaseClient.js';

// Types
export type {
	BaseClientOptions,
	WHIPClientOptions,
	WHEPClientOptions,
	AudioEncodingOptions,
	VideoLayerOptions,
	PublishOptions,
	PublishScreenOptions,
	ViewOptions,
	BaseClientEvents,
	WHIPClientEvents,
	WHEPClientEvents,
	Logger,
	AutoReconnectOptions,
	AdaptiveQualityOptions,
	ConnectionQuality,
	AudioStats,
	VideoStats,
	StreamStats,
} from './core/types.js';

// Errors
export {
	WhipWhepError,
	WHIPError,
	WHEPError,
	TimeoutError,
	InvalidStateError,
} from './core/errors.js';

// SDP utilities (advanced / low-level usage)
export {
	preferCodec,
	setBandwidth,
	addSimulcast,
	patchFmtp,
	extractSsrc,
	removeExtmap,
	listCodecs,
} from './utils/sdp.js';

// ICE utilities (advanced / low-level usage)
export { setupIceTrickle, waitForIceGathering } from './utils/ice.js';
export type { IceTrickleMode, IceTrickleOptions } from './utils/ice.js';

// Media utilities
export { getScreenStream, getUserStream } from './utils/media.js';
export type { ScreenStreamOptions, UserStreamOptions } from './utils/media.js';

// Server presets
export { livekit, ovenmedia, cloudflare, antmedia, millicast, srs, mediamtx } from './presets/index.js';
export type { WHIPPreset, WHEPPreset } from './presets/index.js';
