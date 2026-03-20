import { describe, it, expect } from 'vitest';
import {
	preferCodec,
	setBandwidth,
	addSimulcast,
	patchFmtp,
	extractSsrc,
	removeExtmap,
	listCodecs,
} from '../../src/utils/sdp.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_SDP = [
	'v=0',
	'o=- 123 2 IN IP4 127.0.0.1',
	's=-',
	't=0 0',
	'a=group:BUNDLE audio video',
	'm=audio 9 UDP/TLS/RTP/SAVPF 111 103 104',
	'c=IN IP4 0.0.0.0',
	'a=rtpmap:111 opus/48000/2',
	'a=rtpmap:103 ISAC/16000',
	'a=rtpmap:104 ISAC/32000',
	'a=sendonly',
	'm=video 9 UDP/TLS/RTP/SAVPF 96 97 98 99',
	'c=IN IP4 0.0.0.0',
	'a=rtpmap:96 VP8/90000',
	'a=rtpmap:97 rtx/90000',
	'a=fmtp:97 apt=96',
	'a=rtpmap:98 H264/90000',
	'a=rtpmap:99 rtx/90000',
	'a=fmtp:99 apt=98',
	'a=sendonly',
	'',
].join('\r\n');

const SDP_WITH_SSRC = [
	'v=0',
	'o=- 123 2 IN IP4 127.0.0.1',
	's=-',
	't=0 0',
	'm=audio 9 UDP/TLS/RTP/SAVPF 111',
	'a=rtpmap:111 opus/48000/2',
	'a=ssrc:12345678 cname:test',
	'm=video 9 UDP/TLS/RTP/SAVPF 96',
	'a=rtpmap:96 VP8/90000',
	'a=ssrc:87654321 cname:test',
	'',
].join('\r\n');

const SDP_WITH_EXTMAP = [
	'v=0',
	'o=- 123 2 IN IP4 127.0.0.1',
	's=-',
	't=0 0',
	'm=video 9 UDP/TLS/RTP/SAVPF 96',
	'a=extmap:1 urn:ietf:params:rtp-hdrext:toffset',
	'a=extmap:2 http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time',
	'a=rtpmap:96 VP8/90000',
	'',
].join('\r\n');

// ---------------------------------------------------------------------------
// preferCodec
// ---------------------------------------------------------------------------

describe('preferCodec', () => {
	it('moves preferred audio codec to front of m= line', () => {
		const result = preferCodec(BASE_SDP, 'audio', 'ISAC');
		const mLine = result.split('\r\n').find((l) => l.startsWith('m=audio'));
		expect(mLine).toMatch(/^m=audio \S+ \S+ 103/);
	});

	it('moves preferred video codec and its RTX to front', () => {
		const result = preferCodec(BASE_SDP, 'video', 'H264');
		const mLine = result.split('\r\n').find((l) => l.startsWith('m=video'));
		// H264 is pt 98, its RTX is pt 99
		expect(mLine).toMatch(/^m=video \S+ \S+ 98 99/);
	});

	it('is case-insensitive', () => {
		const result = preferCodec(BASE_SDP, 'video', 'vp8');
		const mLine = result.split('\r\n').find((l) => l.startsWith('m=video'));
		expect(mLine).toMatch(/^m=video \S+ \S+ 96/);
	});

	it('returns SDP unchanged when codec not found', () => {
		const result = preferCodec(BASE_SDP, 'video', 'AV1');
		expect(result).toBe(BASE_SDP);
	});

	it('does not affect other m= sections', () => {
		const result = preferCodec(BASE_SDP, 'video', 'H264');
		const audioLine = result.split('\r\n').find((l) => l.startsWith('m=audio'));
		expect(audioLine).toBe('m=audio 9 UDP/TLS/RTP/SAVPF 111 103 104');
	});
});

// ---------------------------------------------------------------------------
// addSimulcast
// ---------------------------------------------------------------------------

describe('addSimulcast', () => {
	it('adds rid and simulcast lines to video section', () => {
		const result = addSimulcast(BASE_SDP);
		expect(result).toContain('a=rid:high send');
		expect(result).toContain('a=rid:mid send');
		expect(result).toContain('a=rid:low send');
		expect(result).toContain('a=simulcast:send high;mid;low');
	});

	it('does not modify audio section', () => {
		const result = addSimulcast(BASE_SDP);
		const lines = result.split('\r\n');
		const audioIdx = lines.findIndex((l) => l.startsWith('m=audio'));
		const videoIdx = lines.findIndex((l) => l.startsWith('m=video'));
		const audioSection = lines.slice(audioIdx, videoIdx).join('\r\n');
		expect(audioSection).not.toContain('simulcast');
	});

	it('does not add simulcast twice', () => {
		const once = addSimulcast(BASE_SDP);
		const twice = addSimulcast(once);
		const count = (twice.match(/a=simulcast/g) ?? []).length;
		expect(count).toBe(1);
	});

	it('returns SDP unchanged when no video section', () => {
		const audioOnly = [
			'v=0',
			'o=- 1 2 IN IP4 127.0.0.1',
			's=-',
			't=0 0',
			'm=audio 9 UDP/TLS/RTP/SAVPF 111',
			'a=rtpmap:111 opus/48000/2',
			'',
		].join('\r\n');

		const result = addSimulcast(audioOnly);
		expect(result).toBe(audioOnly);
	});
});

// ---------------------------------------------------------------------------
// setBandwidth
// ---------------------------------------------------------------------------

describe('setBandwidth', () => {
	it('adds b=AS and b=TIAS lines to video section', () => {
		const result = setBandwidth(BASE_SDP, 'video', 2000);
		const lines = result.split('\r\n');
		const videoIdx = lines.findIndex((l) => l.startsWith('m=video'));
		const videoSection = lines.slice(videoIdx);
		expect(videoSection).toContain('b=AS:2000');
		expect(videoSection).toContain('b=TIAS:2000000');
	});

	it('adds b= lines to audio section', () => {
		const result = setBandwidth(BASE_SDP, 'audio', 128);
		const lines = result.split('\r\n');
		const audioIdx = lines.findIndex((l) => l.startsWith('m=audio'));
		const videoIdx = lines.findIndex((l) => l.startsWith('m=video'));
		const audioSection = lines.slice(audioIdx, videoIdx);
		expect(audioSection).toContain('b=AS:128');
		expect(audioSection).toContain('b=TIAS:128000');
	});

	it('adds b= lines to session level', () => {
		const result = setBandwidth(BASE_SDP, 'session', 4000);
		const lines = result.split('\r\n');
		// Session-level b= should appear before the first m= line
		const firstMIdx = lines.findIndex((l) => l.startsWith('m='));
		const sessionLines = lines.slice(0, firstMIdx);
		expect(sessionLines).toContain('b=AS:4000');
		expect(sessionLines).toContain('b=TIAS:4000000');
	});

	it('inserts b= lines after the c= line', () => {
		const result = setBandwidth(BASE_SDP, 'video', 1000);
		const lines = result.split('\r\n');
		const videoIdx = lines.findIndex((l) => l.startsWith('m=video'));
		const cIdx = lines.findIndex((l, i) => i > videoIdx && l.startsWith('c='));
		expect(lines[cIdx + 1]).toBe('b=AS:1000');
		expect(lines[cIdx + 2]).toBe('b=TIAS:1000000');
	});

	it('replaces existing b= lines', () => {
		const sdpWithBandwidth = setBandwidth(BASE_SDP, 'video', 1000);
		const updated = setBandwidth(sdpWithBandwidth, 'video', 2000);
		// Only one b=AS line in the video section
		const videoLines = updated.split('\r\n').filter((l) => l.startsWith('b=AS:'));
		expect(videoLines).toHaveLength(1);
		expect(videoLines[0]).toBe('b=AS:2000');
	});

	it('removes b= lines when maxKbps is 0', () => {
		const sdpWithBandwidth = setBandwidth(BASE_SDP, 'video', 1000);
		const result = setBandwidth(sdpWithBandwidth, 'video', 0);
		expect(result).not.toContain('b=AS:');
		expect(result).not.toContain('b=TIAS:');
	});

	it('does not affect other sections', () => {
		const result = setBandwidth(BASE_SDP, 'video', 2000);
		const lines = result.split('\r\n');
		const audioIdx = lines.findIndex((l) => l.startsWith('m=audio'));
		const videoIdx = lines.findIndex((l) => l.startsWith('m=video'));
		const audioSection = lines.slice(audioIdx, videoIdx);
		expect(audioSection).not.toContain('b=AS:2000');
	});
});

// ---------------------------------------------------------------------------
// patchFmtp
// ---------------------------------------------------------------------------

const SDP_WITH_OPUS = [
	'v=0',
	'o=- 123 2 IN IP4 127.0.0.1',
	's=-',
	't=0 0',
	'm=audio 9 UDP/TLS/RTP/SAVPF 111',
	'c=IN IP4 0.0.0.0',
	'a=rtpmap:111 opus/48000/2',
	'a=fmtp:111 minptime=10;useinbandfec=1',
	'a=sendonly',
	'',
].join('\r\n');

const SDP_WITHOUT_FMTP = [
	'v=0',
	'o=- 123 2 IN IP4 127.0.0.1',
	's=-',
	't=0 0',
	'm=audio 9 UDP/TLS/RTP/SAVPF 111',
	'c=IN IP4 0.0.0.0',
	'a=rtpmap:111 opus/48000/2',
	'a=sendonly',
	'',
].join('\r\n');

describe('patchFmtp', () => {
	it('merges new params into existing fmtp line', () => {
		const result = patchFmtp(SDP_WITH_OPUS, 'audio', 'opus', { usedtx: 1 });
		expect(result).toContain('a=fmtp:111 minptime=10;useinbandfec=1;usedtx=1');
	});

	it('overrides existing param with incoming value', () => {
		const result = patchFmtp(SDP_WITH_OPUS, 'audio', 'opus', { useinbandfec: 0 });
		const fmtpLine = result.split('\r\n').find((l) => l.startsWith('a=fmtp:111'));
		expect(fmtpLine).toContain('useinbandfec=0');
		// Should not still contain the old value
		expect(fmtpLine).not.toContain('useinbandfec=1');
	});

	it('creates fmtp line when none exists', () => {
		const result = patchFmtp(SDP_WITHOUT_FMTP, 'audio', 'opus', { stereo: 1 });
		expect(result).toContain('a=fmtp:111 stereo=1');
	});

	it('is case-insensitive for codec name', () => {
		const result = patchFmtp(SDP_WITH_OPUS, 'audio', 'OPUS', { usedtx: 1 });
		expect(result).toContain('usedtx=1');
	});

	it('returns SDP unchanged when codec not found', () => {
		const result = patchFmtp(SDP_WITH_OPUS, 'audio', 'g722', { bitrate: 64 });
		expect(result).toBe(SDP_WITH_OPUS);
	});

	it('handles multiple params in a single call', () => {
		const result = patchFmtp(SDP_WITHOUT_FMTP, 'audio', 'opus', { stereo: 1, usedtx: 1 });
		const fmtpLine = result.split('\r\n').find((l) => l.startsWith('a=fmtp:111'));
		expect(fmtpLine).toContain('stereo=1');
		expect(fmtpLine).toContain('usedtx=1');
	});
});

// ---------------------------------------------------------------------------
// extractSsrc
// ---------------------------------------------------------------------------

describe('extractSsrc', () => {
	it('extracts SSRC from audio section', () => {
		expect(extractSsrc(SDP_WITH_SSRC, 'audio')).toBe(12345678);
	});

	it('extracts SSRC from video section', () => {
		expect(extractSsrc(SDP_WITH_SSRC, 'video')).toBe(87654321);
	});

	it('returns undefined when no SSRC present', () => {
		expect(extractSsrc(BASE_SDP, 'audio')).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// removeExtmap
// ---------------------------------------------------------------------------

describe('removeExtmap', () => {
	it('removes matching extmap lines', () => {
		const result = removeExtmap(SDP_WITH_EXTMAP, 'abs-send-time');
		expect(result).not.toContain('abs-send-time');
		expect(result).toContain('toffset');
	});

	it('preserves non-matching extmap lines', () => {
		const result = removeExtmap(SDP_WITH_EXTMAP, 'abs-send-time');
		expect(result).toContain('a=extmap:1 urn:ietf:params:rtp-hdrext:toffset');
	});
});

// ---------------------------------------------------------------------------
// listCodecs
// ---------------------------------------------------------------------------

describe('listCodecs', () => {
	it('lists audio codecs', () => {
		expect(listCodecs(BASE_SDP, 'audio')).toEqual(['opus', 'ISAC', 'ISAC']);
	});

	it('lists video codecs', () => {
		expect(listCodecs(BASE_SDP, 'video')).toContain('VP8');
		expect(listCodecs(BASE_SDP, 'video')).toContain('H264');
	});

	it('returns empty array when section missing', () => {
		const noVideo = BASE_SDP.split('\r\n')
			.filter((l) => !l.startsWith('m=video'))
			.join('\r\n');
		expect(listCodecs(noVideo, 'video')).toEqual([]);
	});
});
