import { describe, it, expect } from 'vitest';
import {
	preferCodec,
	addSimulcast,
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
