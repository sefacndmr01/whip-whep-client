# whip-whep-client

## 1.2.2

### Patch Changes

- e2b4fc2: Fix release CI broken by Node 22.22.2 runner update

    Upgraded the publish job to Node 24 and removed the `npm install -g npm@latest`
    step. The bundled npm in the Node 22.22.2 GitHub Actions runner image has a
    corrupted installation (missing `promise-retry`) that prevents global npm
    upgrades, causing publish to fail. Node 24 ships with a working npm that
    supports OIDC trusted publishing out of the box.

## 1.2.1

### Patch Changes

- 7d51566: Add server presets for Millicast, SRS, and MediaMTX

    **New presets**
    - `millicast` — Dolby.io Real-time Streaming (managed WebRTC CDN); enforces H.264, enables stereo Opus with DTX and FEC; requires a short-lived publish/subscribe token from the Millicast Director API
    - `srs` — Simple Realtime Server (open-source); H.264 with FEC; optional auth token
    - `mediamtx` — MediaMTX / rtsp-simple-server (open-source, zero-dependency); H.264 with DTX and FEC; optional auth token

## 1.2.0

### Minor Changes

- 5067dca: Add publisher-side features to `WHIPClient`

    **New methods**
    - `muteTrack(kind)` / `unmuteTrack(kind)` — toggle a sender track on/off without renegotiation (sets `MediaStreamTrack.enabled`)
    - `isTrackMuted(kind)` — returns the current mute state of a sender track
    - `publishScreen(options?)` — capture and publish a screen / window / tab via `getDisplayMedia`; supports optional microphone audio (`micAudio`) or display audio (`displayAudio`)
    - `startAudioLevelMonitor(intervalMs?)` / `stopAudioLevelMonitor()` — poll the outgoing audio amplitude via `AudioContext` + `AnalyserNode` and emit normalised RMS values on the new `audiolevel` event
    - `watchStats(intervalMs, callback)` — convenience wrapper around `getStats()` that polls on a fixed interval and returns a cleanup function

    **New event**
    - `audiolevel` on `WHIPClientEvents` — fires while the audio level monitor is active with a normalised RMS value in `[0, 1]`

    **New type**
    - `PublishScreenOptions` — options for `publishScreen()` (`displayAudio`, `micAudio`, `videoConstraints`, `publishOptions`)

    **New option**
    - `signal?: AbortSignal` in `PublishOptions` — cancels an in-flight `publish()` call; the HTTP request is aborted and a `DOMException('AbortError')` is thrown

## 1.1.0

### Minor Changes

- af91cd7: Add `endpointRecovery` and `adaptiveQuality` options to `WHIPClient`.

    **Endpoint Recovery** (`endpointRecovery: boolean`)

    When enabled, a failed WHIP session attempts a lightweight PATCH-based recovery
    before falling back to a full DELETE + POST reconnect. The library stores the
    `ETag` from each successful POST response and sends it in an `If-Match` header
    on the recovery PATCH per RFC 9725 §4.3. If the server still holds the session
    it responds with `200 OK` and a new SDP answer; otherwise the normal reconnect
    flow takes over automatically.

    **Adaptive Quality** (`adaptiveQuality: boolean | AdaptiveQualityOptions`)

    Polls `getStats()` on a configurable interval and scales the video sender's
    `maxBitrate` based on the measured `ConnectionQuality`:
    - `poor` → 25 % of target bitrate
    - `fair` → 50 % of target bitrate
    - `good` → 75 % of target bitrate
    - `excellent` → 100 % of target bitrate

    Hysteresis thresholds (`downgradeThreshold`, `upgradeThreshold`) prevent
    flapping on transient quality changes. A `minVideoBitrate` floor ensures the
    encoder is never throttled below a usable level. Each level transition emits a
    new `qualitychange` event on `WHIPClient`.

    New exports: `AdaptiveQualityOptions` type, `qualitychange` event on
    `WHIPClientEvents`.

## 1.0.2

### Patch Changes

- 3e65844: github tag configuration

## 1.0.1

### Patch Changes

- baeafbd: Fix null RTT quality miscalculation, stream event double-emit guard, redundant track stopping in WHEP reconnect, unsafe SDP insert index fallback, and simulcast frame stats layer selection

## 1.0.0

### Major Changes

- Stable 1.0.0 release. Includes simulcast stats aggregation fix, ICE RTT candidate-pair selection fix, extracted encoding helpers, shared StatsSnapshot type, and comprehensive test coverage across all modules.

## 0.3.1

### Patch Changes

- Fix simulcast stats accumulation using `+=` instead of `=` so all outbound-rtp layers are aggregated correctly. Fix ICE candidate-pair RTT selection to prefer the nominated pair, falling back to any succeeded pair. Extract encoding helpers to `src/whip/encodings.ts` and share `StatsSnapshot` interface from `utils/stats.ts`.
