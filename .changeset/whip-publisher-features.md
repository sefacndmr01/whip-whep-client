---
"whip-whep-client": minor
---

Add publisher-side features to `WHIPClient`

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
