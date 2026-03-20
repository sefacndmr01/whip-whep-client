# whip-whep-client

## 0.3.1

### Patch Changes

- Fix simulcast stats accumulation using `+=` instead of `=` so all outbound-rtp layers are aggregated correctly. Fix ICE candidate-pair RTT selection to prefer the nominated pair, falling back to any succeeded pair. Extract encoding helpers to `src/whip/encodings.ts` and share `StatsSnapshot` interface from `utils/stats.ts`.
