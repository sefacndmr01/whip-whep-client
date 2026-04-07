---
"whip-whep-client": patch
---

Add server presets for Millicast, SRS, and MediaMTX

**New presets**

- `millicast` — Dolby.io Real-time Streaming (managed WebRTC CDN); enforces H.264, enables stereo Opus with DTX and FEC; requires a short-lived publish/subscribe token from the Millicast Director API
- `srs` — Simple Realtime Server (open-source); H.264 with FEC; optional auth token
- `mediamtx` — MediaMTX / rtsp-simple-server (open-source, zero-dependency); H.264 with DTX and FEC; optional auth token
