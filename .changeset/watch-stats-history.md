---
"whip-whep-client": minor
---

Add rolling stats history to `watchStats`

The `watchStats` callback now receives a second `StatsHistory` argument
containing a sliding window of past snapshots. The window size is
configurable via an optional third parameter (default `10`).

**New type**

- `StatsHistory` — read-only rolling window with `snapshots`, `prev`, and
  four averaging helpers: `avgVideoBitrate()`, `avgAudioBitrate()`,
  `avgPacketLossRate()`, `avgRoundTripTime()`

**Changed signature** (backwards-compatible — existing callbacks that ignore
the second argument continue to work)

```ts
// before
watchStats(intervalMs, (stats) => { … })

// after
watchStats(intervalMs, (stats, history) => {
    history.avgVideoBitrate();          // mean over window
    history.prev?.video?.bitrate;       // previous snapshot → delta
}, 30 /* optional historySize */)
```
