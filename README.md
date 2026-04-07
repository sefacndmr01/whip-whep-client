# whip-whep-client

A modern, TypeScript-first client library for the **WHIP** and **WHEP** WebRTC streaming protocols.

[![npm](https://img.shields.io/npm/v/whip-whep-client)](https://www.npmjs.com/package/whip-whep-client)
[![CI](https://github.com/sefacndmr01/whip-whep-client/actions/workflows/release.yml/badge.svg)](https://github.com/sefacndmr01/whip-whep-client/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![npm downloads](https://img.shields.io/npm/dm/whip-whep-client)](https://www.npmjs.com/package/whip-whep-client)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue?logo=typescript&logoColor=white)](https://www.typescriptlang.org)

---

## Overview

WHIP and WHEP are HTTP-based signalling protocols that make WebRTC streaming as simple as a single HTTP POST request. This library wraps the browser WebRTC APIs with a clean, event-driven interface so you can go from zero to streaming in a few lines of code.

- **[RFC 9725 — WebRTC-HTTP Ingestion Protocol (WHIP)](https://www.rfc-editor.org/rfc/rfc9725)** — push a live video/audio stream to any compatible media server.
- **[draft-ietf-wish-whep — WebRTC-HTTP Egress Protocol (WHEP)](https://datatracker.ietf.org/doc/draft-ietf-wish-whep/)** — subscribe to a live stream from any compatible media server or CDN.

### Why this library?

Implementing WHIP or WHEP by hand is entirely possible — the protocol is just an HTTP POST followed by a few optional PATCH requests. In practice, however, the boilerplate grows quickly. The table below shows what you would need to handle yourself compared to using this library.


| Concern                        | Without this library                                                            | With this library                          |
| ------------------------------ | ------------------------------------------------------------------------------- | ------------------------------------------ |
| `RTCPeerConnection` setup      | Create, configure ICE servers, set bundle policy                                | Handled internally                         |
| Adding tracks and transceivers | `addTransceiver` per kind, manage `sendEncodings`                               | Handled internally                         |
| SDP offer/answer exchange      | `fetch` POST, parse `Location` header, `setRemoteDescription`                   | Handled internally                         |
| Trickle ICE via HTTP PATCH     | Listen for `icecandidate`, batch and PATCH to resource URL                      | Handled internally                         |
| Simulcast encodings            | Manually add `a=rid` and `a=simulcast` SDP lines, set `sendEncodings`           | `simulcast: true`                          |
| Bitrate / Opus parameters      | Munge SDP `b=AS`/`b=TIAS`, call `sender.setParameters()` after negotiation      | Declarative options                        |
| Authentication headers         | Pass on every `fetch` call, refresh tokens manually                             | Static or async `getHeaders`               |
| Connection state tracking      | Wire `connectionstatechange`, manage your own state machine                     | Typed events + `state` accessor            |
| Error context                  | Inspect raw `Response.status`, wrap `DOMException` for timeouts                 | Typed error classes with HTTP status       |
| Cleanup                        | DELETE resource URL, close `RTCPeerConnection`, stop tracks                     | `client.stop()`                            |
| Auto-reconnect                 | Track attempt count, implement exponential backoff, re-run full signalling flow  | `autoReconnect: true` or `reconnect()`     |
| Session recovery               | PATCH resource URL with `If-Match` ETag header, fall back gracefully on failure | `endpointRecovery: true`                   |
| Adaptive bitrate               | Poll stats, compute quality score, call `setParameters()` with scaled bitrate   | `adaptiveQuality: true`                    |
| Track replacement              | Find the correct `RTCRtpSender`, call `replaceTrack`, update your stream refs   | `replaceTrack('video', newTrack)`          |
| Muting tracks                  | Find sender, toggle `track.enabled`, re-find it if reconnect swaps sender refs  | `muteTrack('audio')` / `unmuteTrack`       |
| Screen publishing              | `getDisplayMedia`, optionally mix mic, handle errors, stop tracks on failure    | `publishScreen(options?)`                  |
| Stats polling                  | `setInterval` + `getStats()`, manage the timer, remember to clear on stop       | `watchStats(intervalMs, callback)`         |
| Audio level metering           | `AudioContext`, `AnalyserNode`, `getFloatTimeDomainData`, compute RMS, interval | `startAudioLevelMonitor()` → `audiolevel` event |
| Stream statistics              | Iterate `RTCStatsReport`, compute deltas, derive quality from loss + RTT        | `getStats()` returns typed `StreamStats`   |
| ICE hang detection             | Set up a manual timer, tear down the peer connection on expiry                  | `iceConnectionTimeout` option              |
| Logging                        | Sprinkle `console.log` calls, remove for production                             | `logger` option — pass any logger          |
| TypeScript types               | Write your own interfaces or use loosely typed DOM APIs                         | Full types, zero `any` in public API       |


---

## Installation

```bash
npm install whip-whep-client
```

The package ships three output formats:


| Format   | File                   | Use case                         |
| -------- | ---------------------- | -------------------------------- |
| ESM      | `dist/index.mjs`       | Bundlers (Vite, webpack, Rollup) |
| CommonJS | `dist/index.cjs`       | Node.js tooling                  |
| IIFE     | `dist/index.global.js` | `<script>` tag, CDN              |


### CDN (no build step)

```html
<script src="https://unpkg.com/whip-whep-client/dist/index.global.js"></script>
<script>
    const { WHIPClient, WHEPClient } = WhipWhepClient;
</script>
```

---

## Quick Start

### Publish a stream (WHIP)

```ts
import { WHIPClient } from 'whip-whep-client';

const client = new WHIPClient({
    endpoint: 'https://ingest.example.com/whip/live',
    token: 'my-secret-token',
});

client.on('connected', () => console.log('Publishing'));
client.on('disconnected', () => console.log('Paused'));
client.on('failed', (err) => console.error('Error:', err));

const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
await client.publish(stream);

// When done:
await client.stop();
```

### View a stream (WHEP)

```ts
import { WHEPClient } from 'whip-whep-client';

const client = new WHEPClient({
    endpoint: 'https://cdn.example.com/whep/stream/abc123',
    token: 'viewer-token',
});

client.on('stream', (stream) => {
    document.querySelector('video').srcObject = stream;
});

client.on('connected', () => console.log('Watching'));
client.on('failed', (err) => console.error('Error:', err));

await client.view();

// When done:
await client.stop();
```

---

## WHIPClient

Publishes a `MediaStream` to a WHIP-compatible ingest server.

### Constructor

```ts
new WHIPClient(options: WHIPClientOptions)
```

### Options


| Option                   | Type                                          | Default          | Description                                              |
| ------------------------ | --------------------------------------------- | ---------------- | -------------------------------------------------------- |
| `endpoint`               | `string`                                      | required         | WHIP endpoint URL                                        |
| `token`                  | `string`                                      | —                | Sent as `Authorization: Bearer <token>`                  |
| `headers`                | `Record<string, string>`                      | —                | Static custom headers on every request                   |
| `getHeaders`             | `() => Record<string, string> \| Promise<...>` | —               | Dynamic headers resolved before each request             |
| `iceServers`             | `RTCIceServer[]`                              | browser defaults | STUN / TURN servers                                      |
| `iceTransportPolicy`     | `'all' \| 'relay'`                            | `'all'`          | Set to `'relay'` to force TURN                           |
| `iceCandidatePoolSize`   | `number`                                      | `0`              | Pre-gathered ICE candidate pool size                     |
| `timeout`                | `number`                                      | `15000`          | SDP exchange timeout in milliseconds                     |
| `iceConnectionTimeout`   | `number`                                      | —                | Max ms to wait for ICE `'connected'` after SDP exchange  |
| `autoReconnect`          | `boolean \| AutoReconnectOptions`             | —                | Reconnect automatically after a mid-session failure      |
| `logger`                 | `Logger`                                      | —                | Structured logger (e.g. `console`)                       |
| `simulcast`              | `boolean`                                     | `false`          | Enable simulcast (three quality layers)                  |
| `audioCodec`             | `string`                                      | —                | Preferred audio codec (e.g. `'opus'`)                    |
| `videoCodec`             | `string`                                      | —                | Preferred video codec (e.g. `'h264'`, `'vp8'`)           |
| `audio`                  | `AudioEncodingOptions`                        | —                | Advanced audio encoding parameters                       |
| `video`                  | `VideoLayerOptions \| VideoLayerOptions[]`    | —                | Advanced video encoding parameters                       |
| `maxBandwidth`           | `number`                                      | —                | Session bandwidth limit in **kbps** (`b=AS` in SDP)      |
| `endpointRecovery`       | `boolean`                                     | `false`          | Try PATCH-based session recovery before full reconnect (RFC 9725 §4.3) |
| `adaptiveQuality`        | `boolean \| AdaptiveQualityOptions`           | —                | Auto-scale video bitrate based on measured connection quality |
| `peerConnectionConfig`   | `RTCConfiguration`                            | —                | Extra options merged into `RTCPeerConnection` config      |


### `publish(stream, options?)`

```ts
await client.publish(stream: MediaStream, options?: PublishOptions): Promise<void>
```

Starts publishing. Creates the `RTCPeerConnection`, adds media tracks, exchanges SDP with the server, and applies bitrate constraints.

**PublishOptions**


| Option      | Type          | Default          | Description                                          |
| ----------- | ------------- | ---------------- | ---------------------------------------------------- |
| `audio`     | `boolean`     | `true`           | Include the audio track                              |
| `video`     | `boolean`     | `true`           | Include the video track                              |
| `simulcast` | `boolean`     | from constructor | Override simulcast for this call                     |
| `signal`    | `AbortSignal` | —                | Cancel an in-flight `publish()` call; throws `DOMException('AbortError')` |


### `stop()`

```ts
await client.stop(): Promise<void>
```

Sends HTTP DELETE to release the server resource, closes the peer connection, and removes all event listeners. Safe to call multiple times.

### `reconnect()`

```ts
await client.reconnect(): Promise<void>
```

Tears down the current peer connection and re-runs `publish()` with the stream from the last call. Useful for manually handling a `'failed'` event. Requires that `publish()` was called at least once.

### `replaceTrack(kind, track)`

```ts
await client.replaceTrack(kind: 'audio' | 'video', track: MediaStreamTrack): Promise<void>
```

Replaces the active sender track without renegotiation. The swap takes effect immediately via `RTCRtpSender.replaceTrack()`. Common use cases: switching from camera to screen share, muting via a silent track, or swapping microphone devices.

The stored stream used by `reconnect()` is updated automatically so future reconnects use the new track.

### `muteTrack(kind)` / `unmuteTrack(kind)` / `isTrackMuted(kind)`

```ts
client.muteTrack(kind: 'audio' | 'video'): void
client.unmuteTrack(kind: 'audio' | 'video'): void
client.isTrackMuted(kind: 'audio' | 'video'): boolean
```

Toggle a sender track on/off without renegotiation. Muting sets `MediaStreamTrack.enabled = false`, which sends silence (audio) or black frames (video) to the remote end. The track remains live — no SDP exchange occurs. `isTrackMuted` returns `true` when the track is currently muted.

### `publishScreen(options?)`

```ts
const stream = await client.publishScreen(options?: PublishScreenOptions): Promise<MediaStream>
```

Captures a screen, window, or browser tab via `getDisplayMedia` and publishes it immediately. Returns the `MediaStream` that is being published.

**`PublishScreenOptions`**

| Option           | Type                                     | Default | Description                                               |
| ---------------- | ---------------------------------------- | ------- | --------------------------------------------------------- |
| `displayAudio`   | `boolean`                                | `false` | Include the display's system audio                        |
| `micAudio`       | `boolean \| MediaTrackConstraints`       | `false` | Capture microphone audio and mix it into the stream       |
| `videoConstraints` | `MediaTrackConstraints`                | —       | Constraints forwarded to `getDisplayMedia` (resolution, frame rate, etc.) |
| `publishOptions` | `Omit<PublishOptions, 'audio' \| 'video'>` | —     | Extra options forwarded to the underlying `publish()` call (e.g. `signal`) |

### `watchStats(intervalMs, callback)`

```ts
const stop = client.watchStats(intervalMs: number, callback: (stats: StreamStats) => void): () => void
```

Polls `getStats()` on a fixed interval and calls `callback` with each snapshot. Returns a cleanup function — call it to stop polling. Equivalent to a `setInterval` around `getStats()` but automatically cancelled when `stop()` is called.

### `startAudioLevelMonitor(intervalMs?)` / `stopAudioLevelMonitor()`

```ts
client.startAudioLevelMonitor(intervalMs?: number): void   // default: 100 ms
client.stopAudioLevelMonitor(): void
```

Starts polling the outgoing audio amplitude via `AudioContext` + `AnalyserNode`. On each tick the library computes the normalised RMS of the audio buffer and emits an `audiolevel` event with a value in `[0, 1]`. Call `stopAudioLevelMonitor()` to detach the analyser and close the `AudioContext`. The monitor is stopped automatically by `stop()`.

### `getStats()`

```ts
const stats = await client.getStats(): Promise<StreamStats>
```

Returns a normalised snapshot of the current session statistics. Bitrate values are computed as a delta between the current and previous call, so calling `getStats()` periodically (e.g. every second) gives meaningful bitrate readings.

**`StreamStats`**

| Field            | Type                                        | Description                                   |
| ---------------- | ------------------------------------------- | --------------------------------------------- |
| `timestamp`      | `number`                                    | Ms since epoch when the snapshot was taken    |
| `audio`          | `AudioStats \| null`                        | Audio stats, `null` when no audio sender      |
| `video`          | `VideoStats \| null`                        | Video stats, `null` when no video sender      |
| `roundTripTime`  | `number \| null`                            | RTT in seconds from RTCP (null until first report) |
| `quality`        | `'excellent' \| 'good' \| 'fair' \| 'poor'` | Derived from packet loss and RTT              |

**`AudioStats` / `VideoStats`** additionally include `bitrate` (bps), `packetsLost`, `packetsLostRate` (0–1), `jitter` (s). `VideoStats` adds `frameRate`, `width`, and `height`.

### Events


| Event                      | Arguments                       | Description                                        |
| -------------------------- | ------------------------------- | -------------------------------------------------- |
| `connected`                | —                               | ICE + DTLS fully established, media is flowing     |
| `disconnected`             | —                               | Connection temporarily lost (may recover)          |
| `failed`                   | `error: Error`                  | Connection irrecoverably failed                    |
| `reconnecting`             | `attempt: number, delayMs: number` | Auto-reconnect attempt starting                 |
| `reconnected`              | —                               | Auto-reconnect successfully restored the session   |
| `qualitychange`            | `quality: ConnectionQuality`    | Adaptive quality changed the effective bitrate level (requires `adaptiveQuality`) |
| `audiolevel`               | `level: number`                 | Normalised RMS amplitude in `[0, 1]` (requires `startAudioLevelMonitor()`)        |
| `connectionstatechange`    | `state: RTCPeerConnectionState` | Raw connection state changes                       |
| `iceconnectionstatechange` | `state: RTCIceConnectionState`  | ICE connection state changes                       |
| `icegatheringstatechange`  | `state: RTCIceGatheringState`   | ICE gathering state changes                        |


---

## WHEPClient

Subscribes to a live stream from a WHEP-compatible server.

### Constructor

```ts
new WHEPClient(options: WHEPClientOptions)
```

### Options

Shares all base options with `WHIPClient` (`endpoint`, `token`, `headers`, `getHeaders`, `iceServers`, `iceTransportPolicy`, `iceCandidatePoolSize`, `timeout`, `iceConnectionTimeout`, `autoReconnect`, `logger`, `peerConnectionConfig`) plus:

| Option         | Type     | Default | Description                                               |
| -------------- | -------- | ------- | --------------------------------------------------------- |
| `audioCodec`   | `string` | —       | Preferred inbound audio codec                             |
| `videoCodec`   | `string` | —       | Preferred inbound video codec                             |
| `maxBandwidth` | `number` | —       | Bandwidth hint sent to server in **kbps** (`b=AS` in SDP) |


### `view(options?)`

```ts
const stream = await client.view(options?: ViewOptions): Promise<MediaStream>
```

Returns a `MediaStream` that is populated with remote tracks as they arrive. The `'stream'` event fires once all expected tracks are received.

**ViewOptions**


| Option  | Type      | Default | Description   |
| ------- | --------- | ------- | ------------- |
| `audio` | `boolean` | `true`  | Receive audio |
| `video` | `boolean` | `true`  | Receive video |


### `stop()`

Stops all remote tracks, sends HTTP DELETE, and closes the peer connection. Safe to call multiple times.

### `reconnect()`

```ts
await client.reconnect(): Promise<void>
```

Tears down the current peer connection and re-runs `view()` with the options from the last call. The new stream is delivered via the `'stream'` event.

### `getStats()`

```ts
const stats = await client.getStats(): Promise<StreamStats>
```

Same interface as `WHIPClient.getStats()`. Reads from `inbound-rtp` entries (receiver stats) and the active ICE candidate pair for RTT.

### Events

Same as `WHIPClient` (`connected`, `disconnected`, `failed`, `reconnecting`, `reconnected`, `connectionstatechange`, `iceconnectionstatechange`, `icegatheringstatechange`), plus:

| Event    | Arguments             | Description                                          |
| -------- | --------------------- | ---------------------------------------------------- |
| `stream` | `stream: MediaStream` | Remote stream ready to attach to a `<video>` element |


---

## Advanced Usage

### Custom Authentication Headers

Use `headers` for static custom schemes, or `getHeaders` when the header value must be recomputed per request (e.g. refreshable tokens, HMAC signatures).

```ts
// Static custom auth scheme
const client = new WHIPClient({
    endpoint: 'https://ingest.example.com/whip/live',
    headers: {
        'Authorization': 'Token abc123',
        'X-API-Key': 'my-key',
    },
});

// Dynamic – token is refreshed before every request
const client = new WHIPClient({
    endpoint: 'https://ingest.example.com/whip/live',
    getHeaders: async () => ({
        'Authorization': `Bearer ${await tokenStore.getValidToken()}`,
    }),
});

// HMAC request signature (timestamp-based)
const client = new WHEPClient({
    endpoint: 'https://cdn.example.com/whep/stream/abc',
    getHeaders: () => {
        const ts = Date.now().toString();
        return {
            'X-Timestamp': ts,
            'X-Signature': hmac(secret, ts),
        };
    },
});
```

**Priority order** (later entries override earlier ones):

1. Built-in defaults (`Content-Type`, `Authorization` from `token`)
2. Static `headers`
3. Dynamic `getHeaders()` return value
4. Per-request overrides (e.g. `Content-Type: application/trickle-ice-sdpfrag` for PATCH)

### Advanced Audio Encoding

```ts
const client = new WHIPClient({
    endpoint: 'https://ingest.example.com/whip/live',
    audio: {
        maxBitrate: 128_000,       // 128 kbps
        dtx: true,                 // Discontinuous Transmission – saves bandwidth during silence
        stereo: true,              // Force stereo (default: mono)
        fec: true,                 // In-band FEC for packet loss recovery
        comfortNoise: false,       // Comfort noise generation
        contentHint: 'speech',     // Encoder hint: 'speech' | 'speech-recognition' | 'music'
    },
});
```

`dtx`, `stereo`, `fec`, and `comfortNoise` are written into the SDP offer as `a=fmtp` Opus parameters per [RFC 7587](https://www.rfc-editor.org/rfc/rfc7587). `maxBitrate` is applied via `RTCRtpSender.setParameters()` after negotiation.

### Advanced Video Encoding (single layer)

```ts
const client = new WHIPClient({
    endpoint: 'https://ingest.example.com/whip/live',
    video: {
        maxBitrate: 2_500_000,      // 2.5 Mbps
        maxFramerate: 30,
        scaleResolutionDownBy: 1,   // Full resolution
        contentHint: 'motion',      // 'motion' | 'detail' | 'text'
    },
});
```

### Simulcast

When `simulcast: true`, three quality layers are created by default. Override them to control each layer independently:

```ts
const client = new WHIPClient({
    endpoint: 'https://ingest.example.com/whip/live',
    simulcast: true,
    video: [
        { rid: 'high', maxBitrate: 2_500_000, scaleResolutionDownBy: 1 },
        { rid: 'mid',  maxBitrate: 1_000_000, scaleResolutionDownBy: 2 },
        { rid: 'low',  maxBitrate:   300_000, scaleResolutionDownBy: 4 },
    ],
});
```

Simulcast requires server-side support. Refer to your media server documentation (e.g. [Janus](https://janus.conf.meetecho.com/), [mediasoup](https://mediasoup.org/), [LiveKit](https://livekit.io/)) for configuration details.

### Session Bandwidth

```ts
const client = new WHIPClient({
    endpoint: 'https://ingest.example.com/whip/live',
    maxBandwidth: 4_000,   // Adds b=AS:4000 and b=TIAS:4000000 to the SDP offer
});
```

`b=AS` is defined in [RFC 4566 §5.8](https://www.rfc-editor.org/rfc/rfc4566#section-5.8) and `b=TIAS` in [RFC 3890](https://www.rfc-editor.org/rfc/rfc3890). Actual enforcement depends on the server implementation.

### Force TURN Relay

```ts
const client = new WHEPClient({
    endpoint: 'https://cdn.example.com/whep/stream/abc',
    iceServers: [{ urls: 'turn:turn.example.com', username: 'user', credential: 'pass' }],
    iceTransportPolicy: 'relay',   // Discard all non-relay candidates
});
```

### Codec Preference

```ts
// Prefer H.264 and Opus on the sending side
const publisher = new WHIPClient({
    endpoint: '...',
    videoCodec: 'h264',
    audioCodec: 'opus',
});

// Prefer VP8 on the receiving side
const viewer = new WHEPClient({
    endpoint: '...',
    videoCodec: 'vp8',
});
```

Codec preference reorders the payload type list in the `m=` line of the SDP offer. The server is not obligated to honour it, but most implementations respect the order.

### Screen Share (legacy)

`WHIPClient.publish()` accepts any `MediaStream`. For screen capture, prefer `publishScreen()` or the `getScreenStream` utility which sets the correct `contentHint` automatically. Raw `getDisplayMedia` also works:

```ts
const screen = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
await client.publish(screen, { audio: true, video: true });
```

### Screen Share

Use `publishScreen()` to capture and publish in one call. It handles `getDisplayMedia`, optional mic mixing, and cleans up tracks if publishing fails:

```ts
const stream = await client.publishScreen({
    displayAudio: true,   // include system audio if the browser/OS allows
    micAudio: true,       // also capture microphone
    videoConstraints: { frameRate: { ideal: 15 }, width: { max: 1920 } },
});
```

For capture-only (without publishing), use the `getScreenStream` utility:

```ts
import { getScreenStream } from 'whip-whep-client';

const screen = await getScreenStream({
    audio: false,
    videoConstraints: { frameRate: { ideal: 15 }, width: { max: 1280 } },
});
```

### Muting Tracks

Toggle audio or video on/off without renegotiation:

```ts
// Mute microphone — sends silence to the remote end
client.muteTrack('audio');

// Unmute — resumes sending real audio
client.unmuteTrack('audio');

// Check current state
if (client.isTrackMuted('video')) {
    console.log('Camera is muted (sending black frames)');
}
```

### Audio Level Monitoring

Listen to outgoing audio amplitude in real time:

```ts
client.on('audiolevel', (level) => {
    // level is a normalised RMS value in [0, 1]
    vuMeter.style.width = `${level * 100}%`;
});

client.startAudioLevelMonitor(50);   // poll every 50 ms (default: 100 ms)

// Stop monitoring (also called automatically by stop()):
client.stopAudioLevelMonitor();
```

### Watching Stats

`watchStats` is a convenience wrapper around `getStats()` that handles the interval and cleanup:

```ts
const stopWatching = client.watchStats(1_000, (stats) => {
    console.log('Quality:', stats.quality);
    console.log('Video bitrate:', stats.video?.bitrate, 'bps');
    console.log('RTT:', stats.roundTripTime, 's');
});

// Stop polling (also cancelled automatically by stop()):
stopWatching();
```

### Cancelling publish()

Pass an `AbortSignal` to cancel an in-flight `publish()` call:

```ts
const controller = new AbortController();

// Cancel after 5 seconds
const timer = setTimeout(() => controller.abort(), 5_000);

try {
    await client.publish(stream, { signal: controller.signal });
    clearTimeout(timer);
} catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
        console.log('Publish was cancelled');
    }
}
```

### Camera and Microphone

`getUserStream` is a convenience wrapper around `getUserMedia` that sets `contentHint` automatically:

```ts
import { getUserStream } from 'whip-whep-client';

const stream = await getUserStream({
    videoContentHint: 'motion',    // default — optimises for camera movement
    audioContentHint: 'speech',    // default — optimises Opus for voice
});
await client.publish(stream);
```

### Replacing an Active Track

Switch from camera to screen share (or swap devices) mid-session without renegotiation:

```ts
import { getScreenStream } from 'whip-whep-client';

const screen = await getScreenStream();
await client.replaceTrack('video', screen.getVideoTracks()[0]);

// Switch back to camera:
const cam = await navigator.mediaDevices.getUserMedia({ video: true });
await client.replaceTrack('video', cam.getVideoTracks()[0]);
```

### Auto-Reconnect

Pass `autoReconnect: true` to automatically retry when the connection fails after a successful session:

```ts
const client = new WHIPClient({
    endpoint: 'https://ingest.example.com/whip/live',
    token: 'my-token',
    autoReconnect: true,
});

client.on('reconnecting', (attempt, delayMs) => {
    console.log(`Reconnect attempt ${attempt} in ${delayMs}ms`);
});
client.on('reconnected', () => {
    console.log('Session restored');
});

const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
await client.publish(stream);
```

Fine-tune the retry policy with `AutoReconnectOptions`:

```ts
const client = new WHIPClient({
    endpoint: '...',
    autoReconnect: {
        maxAttempts: 10,          // default: 5
        initialDelayMs: 500,      // default: 1 000 ms — delay before 2nd attempt
        maxDelayMs: 60_000,       // default: 30 000 ms — cap on inter-attempt delay
        backoff: 'exponential',   // default — doubles each time; 'fixed' keeps initialDelayMs
    },
});
```

Manual reconnect is also available:

```ts
client.on('failed', async () => {
    await client.reconnect();
});
```

Auto-reconnect only fires when the connection was previously `'connected'`. It does not retry signalling errors (e.g. a `401` from the server).

### Endpoint Recovery

When a WHIP session drops, the default reconnect flow sends HTTP DELETE to release the server resource and then re-opens a brand-new session with a fresh HTTP POST. If the server is still holding the session (e.g. a brief network hiccup), the full teardown is unnecessary overhead.

Enable `endpointRecovery: true` to attempt a lighter-weight recovery first, per [RFC 9725 §4.3](https://www.rfc-editor.org/rfc/rfc9725#section-4.3):

1. The library stores the `ETag` from each successful WHIP POST response.
2. On reconnect, it sends a PATCH to the resource URL with the new SDP offer and an `If-Match: <etag>` header — **without deleting the resource first**.
3. If the server still holds the session it responds with `200 OK` and a new SDP answer; the session resumes without re-creating a server-side resource.
4. If the server rejects the PATCH (e.g. `404 Not Found` when the session has expired), the library falls back to the normal DELETE + POST reconnect automatically.

```ts
const client = new WHIPClient({
    endpoint: 'https://ingest.example.com/whip/live',
    token: 'my-token',
    autoReconnect: true,
    endpointRecovery: true,   // try PATCH recovery before falling back to full reconnect
});

client.on('reconnecting', (attempt) => console.log(`Attempt ${attempt}`));
client.on('reconnected', () => console.log('Session restored'));

await client.publish(stream);
```

`endpointRecovery` only applies to `WHIPClient`. It requires `autoReconnect` or a manual `reconnect()` call to be useful. Enabling it has no effect unless the server supports the PATCH-based recovery flow.

### Adaptive Quality

When network conditions deteriorate, the browser's built-in congestion control reduces bitrate, but it cannot prevent the connection quality indicator from flipping to `'poor'` before any reduction takes effect. `adaptiveQuality` lets you act on quality measurements proactively by scaling the video `maxBitrate` in sync with the measured `ConnectionQuality`.

```ts
const client = new WHIPClient({
    endpoint: 'https://ingest.example.com/whip/live',
    video: { maxBitrate: 2_500_000 },   // target bitrate at 'excellent' quality
    adaptiveQuality: true,              // use defaults (see table below)
});

client.on('qualitychange', (quality) => {
    console.log('Bitrate scaled for:', quality);
    // 'poor'      → 25 % of target  (625 kbps)
    // 'fair'      → 50 % of target  (1 250 kbps)
    // 'good'      → 75 % of target  (1 875 kbps)
    // 'excellent' → 100 % of target (2 500 kbps)
});

await client.publish(stream);
```

Fine-tune the adaptation policy:

```ts
const client = new WHIPClient({
    endpoint: '...',
    video: { maxBitrate: 3_000_000 },
    adaptiveQuality: {
        intervalMs: 3_000,          // how often to sample stats (default: 5 000 ms)
        downgradeThreshold: 2,      // consecutive degraded readings before scaling down (default: 2)
        upgradeThreshold: 4,        // consecutive improved readings before scaling up (default: 4)
        minVideoBitrate: 200_000,   // never throttle below this value (default: 150 000 bps)
    },
});
```

**`AdaptiveQualityOptions`**

| Option                | Type     | Default     | Description                                                            |
| --------------------- | -------- | ----------- | ---------------------------------------------------------------------- |
| `intervalMs`          | `number` | `5000`      | Stats polling interval in milliseconds                                 |
| `downgradeThreshold`  | `number` | `2`         | Consecutive readings worse than current level needed to scale down     |
| `upgradeThreshold`    | `number` | `4`         | Consecutive readings better than current level needed to scale up      |
| `minVideoBitrate`     | `number` | `150000`    | Minimum video bitrate floor in **bps**; bitrate is never set below this |

**Bitrate scaling table**

| Measured quality | Target factor | Example (target 2.5 Mbps) |
| ---------------- | ------------- | ------------------------- |
| `excellent`      | 100 %         | 2 500 kbps                |
| `good`           | 75 %          | 1 875 kbps                |
| `fair`           | 50 %          | 1 250 kbps                |
| `poor`           | 25 %          | 625 kbps                  |

The target bitrate is taken from `video.maxBitrate` when set, or defaults to 2.5 Mbps. Adaptive quality does not modify simulcast layer activity; it adjusts the `maxBitrate` on the single-layer video sender.

### Connection Quality and Stats

Poll `getStats()` on an interval to monitor stream health:

```ts
import type { StreamStats } from 'whip-whep-client';

const timer = setInterval(async () => {
    const stats: StreamStats = await client.getStats();

    console.log('Quality:', stats.quality);          // 'excellent' | 'good' | 'fair' | 'poor'
    console.log('RTT:', stats.roundTripTime);         // seconds
    console.log('Video bitrate:', stats.video?.bitrate, 'bps');
    console.log('Packet loss:', stats.video?.packetsLostRate); // 0–1
}, 2_000);

// Clean up:
clearInterval(timer);
```

Quality thresholds:

| Quality     | Packet-loss rate | RTT         |
| ----------- | --------------- | ----------- |
| `excellent` | < 1 %           | < 50 ms     |
| `good`      | < 3 %           | < 150 ms    |
| `fair`      | < 8 %           | < 300 ms    |
| `poor`      | ≥ 8 %           | ≥ 300 ms    |

### ICE Connection Timeout

Set `iceConnectionTimeout` to fail fast when ICE negotiation stalls:

```ts
const client = new WHIPClient({
    endpoint: '...',
    timeout: 10_000,              // SDP POST must complete within 10 s
    iceConnectionTimeout: 15_000, // ICE must reach 'connected' within 15 s
});
```

`iceConnectionTimeout` is independent of `timeout`. When the ICE deadline passes, a `TimeoutError` is thrown and the session is cleaned up.

### Logging

Pass any object with `debug`, `info`, `warn`, and `error` methods:

```ts
// Development – log everything to the console
const client = new WHIPClient({
    endpoint: '...',
    logger: console,
});

// Production – structured logger (e.g. pino)
import pino from 'pino';
const client = new WHIPClient({
    endpoint: '...',
    logger: pino({ level: 'warn' }),
});
```

The logger receives messages for all significant internal events: HTTP requests, SDP exchange, ICE state changes, connection state transitions, and reconnect attempts.

### Connection State Handling

```ts
const client = new WHIPClient({ endpoint: '...' });

client.on('connectionstatechange', (state) => {
    const actions = {
        connected:    () => showStatus('Live'),
        disconnected: () => showStatus('Reconnecting…'),
        failed:       () => { showStatus('Failed'); client.stop(); },
    };
    actions[state]?.();
});
```

---

## Error Handling

All errors thrown by `publish()`, `view()`, and `stop()` extend `WhipWhepError`.

```ts
import { WHIPError, WHEPError, TimeoutError, InvalidStateError } from 'whip-whep-client';

try {
    await client.publish(stream);
} catch (err) {
    if (err instanceof TimeoutError) {
        console.error('SDP exchange took too long');
    } else if (err instanceof WHIPError && err.status === 401) {
        console.error('Unauthorized – check your token');
    } else if (err instanceof WHIPError && err.status === 503) {
        console.error('Server is at capacity');
    } else {
        throw err;
    }
}
```


| Class               | When thrown                                                                         |
| ------------------- | ----------------------------------------------------------------------------------- |
| `WHIPError`         | `WHIPClient.publish()` — server rejected the offer or network error                 |
| `WHEPError`         | `WHEPClient.view()` — server rejected the offer or network error                    |
| `TimeoutError`      | SDP exchange exceeded `options.timeout`, or ICE exceeded `iceConnectionTimeout`     |
| `InvalidStateError` | Method called in wrong lifecycle state (e.g. `publish()` on a non-idle client)      |


All error classes expose a `status: number | undefined` property containing the HTTP response status code.

---

## SDP Utilities

Low-level SDP helpers are exported for advanced use cases (e.g. custom signalling layers, testing):

```ts
import { preferCodec, setBandwidth, addSimulcast, patchFmtp, listCodecs } from 'whip-whep-client';

// Prefer H.264 in the video section
const modifiedSdp = preferCodec(originalSdp, 'video', 'H264');

// Add a 3 Mbps bandwidth limit to the video section
const bwSdp = setBandwidth(originalSdp, 'video', 3_000);

// List all codec names in the audio section
const codecs = listCodecs(sdp, 'audio'); // ['opus', 'ISAC', ...]

// Patch Opus fmtp parameters
const opusSdp = patchFmtp(sdp, 'audio', 'opus', { usedtx: 1, stereo: 1 });
```

---

## ICE Utilities

```ts
import { setupIceTrickle, waitForIceGathering } from 'whip-whep-client';

// Manual trickle ICE setup
const cleanup = setupIceTrickle(pc, {
    mode: 'end-of-candidates',   // or 'immediate'
    onCandidates: async (candidates) => {
        await fetch(resourceUrl, {
            method: 'PATCH',
            body: candidates.map((c) => `a=${c.candidate}`).join('\r\n'),
        });
    },
    onGatheringComplete: () => console.log('ICE gathering done'),
});

// Later:
cleanup();
```

---

## TypeScript

The library is written in TypeScript and ships full type declarations. Generic type parameters are inferred automatically.

```ts
import type {
    WHIPClientOptions,
    WHEPClientOptions,
    AudioEncodingOptions,
    VideoLayerOptions,
    AutoReconnectOptions,
    AdaptiveQualityOptions,
    PublishScreenOptions,
    Logger,
    StreamStats,
    ConnectionQuality,
    BaseClientEvents,
    WHIPClientEvents,
    WHEPClientEvents,
    ClientState,
} from 'whip-whep-client';

// Extend WHEPClientEvents to add custom events
interface MyPlayerEvents extends WHEPClientEvents {
    buffering: () => void;
}
```

---

## Server Compatibility

The library works with any server that implements the WHIP or WHEP specification. Built-in presets provide recommended default options for the most widely used servers so you do not need to research per-server quirks manually.

### Using presets

A preset is a plain options object that can be spread into the client constructor. You supply the `endpoint`; the preset fills in the codec, simulcast, and audio defaults that are known to work well with that server.

```ts
import { WHIPClient, livekit } from 'whip-whep-client';

const client = new WHIPClient({
    endpoint: 'https://my-project.livekit.cloud/rtc/whip',
    ...livekit.whip('my-access-token'),
});
```

Overriding a preset field is done through normal spread precedence:

```ts
const client = new WHIPClient({
    endpoint: 'https://...',
    ...livekit.whip(token),
    timeout: 20_000,       // overrides preset default
    simulcast: false,      // opt out of simulcast
});
```

---

### LiveKit

[LiveKit](https://livekit.io) is an open-source WebRTC SFU with managed cloud and self-hosted options.


|                |                                                                                    |
| -------------- | ---------------------------------------------------------------------------------- |
| WHIP endpoint  | `https://<project>.livekit.cloud/rtc/whip`                                         |
| WHEP endpoint  | `https://<project>.livekit.cloud/rtc/whep`                                         |
| Authentication | LiveKit Access Token (JWT) as Bearer token                                         |
| Docs           | [livekit.io/realtime/ingress/whip](https://docs.livekit.io/realtime/ingress/whip/) |


```ts
import { WHIPClient, WHEPClient, livekit } from 'whip-whep-client';

// Publish
const publisher = new WHIPClient({
    endpoint: 'https://my-project.livekit.cloud/rtc/whip',
    ...livekit.whip(accessToken),
});
const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
await publisher.publish(stream);

// View
const viewer = new WHEPClient({
    endpoint: 'https://my-project.livekit.cloud/rtc/whep',
    ...livekit.whep(accessToken),
});
const remoteStream = await viewer.view();
videoEl.srcObject = remoteStream;
```

The preset enables simulcast and H.264 video by default, which are the recommended settings for LiveKit Cloud.

---

### OvenMedia Engine

[OvenMedia Engine (OME)](https://github.com/AirenSoft/OvenMediaEngine) is an open-source, real-time streaming server with native WHIP and WHEP support.


|                |                                                                                                       |
| -------------- | ----------------------------------------------------------------------------------------------------- |
| WHIP endpoint  | `http://<host>:3333/<app>/<stream>`                                                                   |
| WHEP endpoint  | `http://<host>:3334/<app>/<stream>`                                                                   |
| Authentication | Signed policy token (optional, configured per application)                                            |
| Docs           | [airensoft.gitbook.io/ovenmediaengine](https://airensoft.gitbook.io/ovenmediaengine/live-source/whip) |


```ts
import { WHIPClient, WHEPClient, ovenmedia } from 'whip-whep-client';

// Publish (no auth)
const publisher = new WHIPClient({
    endpoint: 'http://localhost:3333/live/stream1',
    ...ovenmedia.whip(),
});

// Publish (with signed policy token)
const publisher = new WHIPClient({
    endpoint: 'http://localhost:3333/live/stream1',
    ...ovenmedia.whip('signed-policy-token'),
});

// View
const viewer = new WHEPClient({
    endpoint: 'http://localhost:3334/live/stream1',
    ...ovenmedia.whep(),
});
```

---

### Cloudflare Stream

[Cloudflare Stream](https://developers.cloudflare.com/stream/) is a managed video platform with WHIP ingest and WHEP egress support.


|                |                                                                                                       |
| -------------- | ----------------------------------------------------------------------------------------------------- |
| WHIP endpoint  | `https://customer-<uid>.cloudflarestream.com/<live-input-key>/webrtc/publish`                         |
| WHEP endpoint  | `https://customer-<uid>.cloudflarestream.com/<live-input-key>/webrtc/play`                            |
| Authentication | Embedded in the endpoint URL — no separate header required                                            |
| Docs           | [developers.cloudflare.com/stream/webrtc-beta](https://developers.cloudflare.com/stream/webrtc-beta/) |


The `<live-input-key>` is obtained when creating a Live Input via the Cloudflare Stream API or dashboard.

```ts
import { WHIPClient, WHEPClient, cloudflare } from 'whip-whep-client';

const liveInputKey = 'abc123...';
const uid = 'customer-xyz';

// Publish
const publisher = new WHIPClient({
    endpoint: `https://${uid}.cloudflarestream.com/${liveInputKey}/webrtc/publish`,
    ...cloudflare.whip(),
});

// View
const viewer = new WHEPClient({
    endpoint: `https://${uid}.cloudflarestream.com/${liveInputKey}/webrtc/play`,
    ...cloudflare.whep(),
});
```

Cloudflare Stream requires H.264 video. The preset enforces this and sets a 128 kbps audio limit that aligns with Cloudflare's recommended encoding settings.

---

### Ant Media Server

[Ant Media Server (AMS)](https://antmedia.io) is an open-source media server with Community and Enterprise editions, both supporting WHIP and WHEP.


|                |                                                                                                    |
| -------------- | -------------------------------------------------------------------------------------------------- |
| WHIP endpoint  | `http://<host>:5080/<app>/whip/<streamId>`                                                         |
| WHEP endpoint  | `http://<host>:5080/<app>/whep/<streamId>`                                                         |
| Authentication | JWT Bearer token (Enterprise, when authentication is enabled)                                      |
| Docs           | [antmedia.io/docs — WHIP](https://antmedia.io/docs/guides/publish-live-stream/WebRTC/webrtc-whip/) |


```ts
import { WHIPClient, WHEPClient, antmedia } from 'whip-whep-client';

// Publish (Community, no auth)
const publisher = new WHIPClient({
    endpoint: 'http://localhost:5080/WebRTCAppEE/whip/stream1',
    ...antmedia.whip(),
});

// Publish (Enterprise, with JWT)
const publisher = new WHIPClient({
    endpoint: 'https://ams.example.com:5443/WebRTCAppEE/whip/stream1',
    ...antmedia.whip(jwtToken),
});

// View
const viewer = new WHEPClient({
    endpoint: 'http://localhost:5080/WebRTCAppEE/whep/stream1',
    ...antmedia.whep(),
});
```

---

### Millicast

[Millicast](https://dolby.io/products/real-time-streaming/) (Dolby.io Real-time Streaming) is a managed WebRTC CDN that delivers sub-second latency at global scale via WHIP ingest and WHEP egress.


|                |                                                                                          |
| -------------- | ---------------------------------------------------------------------------------------- |
| WHIP endpoint  | `https://director.millicast.com/api/whip/<streamName>`                                  |
| WHEP endpoint  | `https://director.millicast.com/api/whep/<streamName>`                                  |
| Authentication | Short-lived publish/subscribe token from the Millicast Director API (Bearer)             |
| Docs           | [docs.dolby.io/streaming-apis/docs/whip](https://docs.dolby.io/streaming-apis/docs/whip) |


```ts
import { WHIPClient, WHEPClient, millicast } from 'whip-whep-client';

// Publish
const publisher = new WHIPClient({
    endpoint: 'https://director.millicast.com/api/whip/my-stream',
    ...millicast.whip(publishToken),
});
const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
await publisher.publish(stream);

// View
const viewer = new WHEPClient({
    endpoint: 'https://director.millicast.com/api/whep/my-stream',
    ...millicast.whep(subscribeToken),
});
const remoteStream = await viewer.view();
videoEl.srcObject = remoteStream;
```

The preset enforces H.264 and enables stereo Opus with DTX and FEC. Tokens are short-lived — obtain them server-side from the Millicast Director API and never embed long-lived API secrets in client code.

---

### SRS

[SRS (Simple Realtime Server)](https://ossrs.io) is a popular open-source media server with native WHIP and WHEP support.


|                |                                                                                           |
| -------------- | ----------------------------------------------------------------------------------------- |
| WHIP endpoint  | `http://<host>:1985/rtc/v1/whip/?app=<app>&stream=<streamName>`                          |
| WHEP endpoint  | `http://<host>:1985/rtc/v1/whep/?app=<app>&stream=<streamName>`                          |
| Authentication | Optional — configure `http_hooks` or `security` in `srs.conf`                            |
| Docs           | [ossrs.io/lts/en-us/docs/v6/doc/whip](https://ossrs.io/lts/en-us/docs/v6/doc/whip)      |


```ts
import { WHIPClient, WHEPClient, srs } from 'whip-whep-client';

// Publish (no auth)
const publisher = new WHIPClient({
    endpoint: 'http://localhost:1985/rtc/v1/whip/?app=live&stream=stream1',
    ...srs.whip(),
});

// Publish (with auth token)
const publisher = new WHIPClient({
    endpoint: 'http://localhost:1985/rtc/v1/whip/?app=live&stream=stream1',
    ...srs.whip(token),
});

// View
const viewer = new WHEPClient({
    endpoint: 'http://localhost:1985/rtc/v1/whep/?app=live&stream=stream1',
    ...srs.whep(),
});
```

---

### MediaMTX

[MediaMTX](https://github.com/bluenviron/mediamtx) (formerly rtsp-simple-server) is a lightweight, zero-dependency media server with built-in WHIP and WHEP support. It requires no external dependencies and is configured via a single `mediamtx.yml` file.


|                |                                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------- |
| WHIP endpoint  | `http://<host>:8889/<pathName>/whip`                                                              |
| WHEP endpoint  | `http://<host>:8889/<pathName>/whep`                                                              |
| Authentication | Optional — configured per-path in `mediamtx.yml`                                                 |
| Docs           | [github.com/bluenviron/mediamtx#webrtc](https://github.com/bluenviron/mediamtx#webrtc)           |


```ts
import { WHIPClient, WHEPClient, mediamtx } from 'whip-whep-client';

// Publish (no auth)
const publisher = new WHIPClient({
    endpoint: 'http://localhost:8889/stream1/whip',
    ...mediamtx.whip(),
});

// Publish (with auth token)
const publisher = new WHIPClient({
    endpoint: 'http://localhost:8889/stream1/whip',
    ...mediamtx.whip(token),
});

// View
const viewer = new WHEPClient({
    endpoint: 'http://localhost:8889/stream1/whep',
    ...mediamtx.whep(),
});
```

---

### Other servers

Any WHIP or WHEP-compliant server works without a preset. Pass the `endpoint` and any required authentication directly:

```ts
import { WHIPClient } from 'whip-whep-client';

const client = new WHIPClient({
    endpoint: 'https://media.example.com/whip/room1',
    token: 'bearer-token',
    videoCodec: 'h264',
});
```

If you have verified that a server works well with specific options, contributions of new presets are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Protocol References

- [RFC 9725 — WebRTC-HTTP Ingestion Protocol (WHIP)](https://www.rfc-editor.org/rfc/rfc9725) — published March 2025, IETF Standards Track
- [draft-ietf-wish-whep — WebRTC-HTTP Egress Protocol (WHEP)](https://datatracker.ietf.org/doc/draft-ietf-wish-whep/) — IETF working draft
- [RFC 8829 — JavaScript Session Establishment Protocol (JSEP)](https://www.rfc-editor.org/rfc/rfc8829) — SDP offer/answer model used by WebRTC
- [RFC 4566 — Session Description Protocol (SDP)](https://www.rfc-editor.org/rfc/rfc4566) — `b=AS` and other bandwidth attributes
- [RFC 3890 — A Transport Independent Bandwidth Modifier for SDP (TIAS)](https://www.rfc-editor.org/rfc/rfc3890) — `b=TIAS`
- [RFC 7587 — RTP Payload Format for the Opus Speech and Audio Codec](https://www.rfc-editor.org/rfc/rfc7587) — Opus `a=fmtp` parameters (DTX, FEC, stereo)
- [W3C WebRTC 1.0](https://www.w3.org/TR/webrtc/) — `RTCPeerConnection`, `RTCRtpSender.setParameters()`, `RTCRtpEncodingParameters`

---

## Browser Support

Requires a browser with support for the [WebRTC 1.0 API](https://caniuse.com/rtcpeerconnection) (`RTCPeerConnection`, `MediaStream`). This covers all modern browsers (Chrome 56+, Firefox 44+, Safari 11+, Edge 79+).

No polyfills are included. The library does not support Node.js at runtime (only as a type-check / build-time dependency).

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, commit conventions, and release workflow.

---

## License

[MIT](LICENSE)