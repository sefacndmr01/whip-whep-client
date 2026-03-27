# whip-whep-client

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
