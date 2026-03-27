---
"whip-whep-client": minor
---

Add `endpointRecovery` and `adaptiveQuality` options to `WHIPClient`.

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
