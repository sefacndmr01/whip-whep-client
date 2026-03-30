import { vi } from 'vitest';

// ---------------------------------------------------------------------------
// RTCRtpSender mock
// ---------------------------------------------------------------------------

class MockRTCRtpSender {
	track: MediaStreamTrack | null;
	private encodings: RTCRtpEncodingParameters[];

	constructor(track: MediaStreamTrack | null, sendEncodings: RTCRtpEncodingParameters[] = []) {
		this.track = track;
		this.encodings = sendEncodings.length > 0 ? sendEncodings : [{ active: true }];
	}

	getParameters(): RTCRtpSendParameters {
		return {
			encodings: this.encodings.map((e) => ({ ...e })),
			transactionId: 'mock-transaction',
			rtcp: {},
			codecs: [],
			headerExtensions: [],
		} as unknown as RTCRtpSendParameters;
	}

	async setParameters(params: RTCRtpSendParameters): Promise<void> {
		this.encodings = params.encodings ?? this.encodings;
	}

	async replaceTrack(track: MediaStreamTrack | null): Promise<void> {
		this.track = track;
	}
}

// ---------------------------------------------------------------------------
// RTCPeerConnection mock
// ---------------------------------------------------------------------------

class MockRTCPeerConnection {
	connectionState: RTCPeerConnectionState = 'new';
	iceConnectionState: RTCIceConnectionState = 'new';
	iceGatheringState: RTCIceGatheringState = 'new';

	private listeners = new Map<string, Set<EventListener>>();
	private transceivers: MockRTCRtpTransceiver[] = [];
	private senders: MockRTCRtpSender[] = [];
	private receivers: MockRTCRtpReceiver[] = [];

	localDescription: RTCSessionDescription | null = null;
	remoteDescription: RTCSessionDescription | null = null;

	constructor(_config?: RTCConfiguration) {}

	addEventListener(type: string, listener: EventListener) {
		if (!this.listeners.has(type)) this.listeners.set(type, new Set());
		this.listeners.get(type)!.add(listener);
	}

	removeEventListener(type: string, listener: EventListener) {
		this.listeners.get(type)?.delete(listener);
	}

	dispatchEvent(type: string, event: Event) {
		this.listeners.get(type)?.forEach((fn) => fn(event));
	}

	addTransceiver(trackOrKind: MediaStreamTrack | string, init?: RTCRtpTransceiverInit) {
		const track = typeof trackOrKind === 'string' ? null : trackOrKind;
		const sender = new MockRTCRtpSender(
			track,
			init?.sendEncodings as RTCRtpEncodingParameters[],
		);
		const transceiver = new MockRTCRtpTransceiver(sender, init);
		this.transceivers.push(transceiver);
		this.senders.push(sender);

		if (init?.direction === 'recvonly') {
			const kind = typeof trackOrKind === 'string' ? trackOrKind : trackOrKind.kind;
			this.receivers.push(new MockRTCRtpReceiver(kind));
		}

		return transceiver;
	}

	getSenders(): MockRTCRtpSender[] {
		return [...this.senders];
	}

	getReceivers(): MockRTCRtpReceiver[] {
		return [...this.receivers];
	}

	private _mockStats: Map<string, unknown> = new Map();

	setMockStats(entries: Map<string, unknown>) {
		this._mockStats = entries;
	}

	async getStats(): Promise<RTCStatsReport> {
		return this._mockStats as unknown as RTCStatsReport;
	}

	async createOffer(): Promise<RTCSessionDescriptionInit> {
		return { type: 'offer', sdp: MOCK_SDP_OFFER };
	}

	async setLocalDescription(desc: RTCSessionDescriptionInit) {
		this.localDescription = desc as RTCSessionDescription;
	}

	async setRemoteDescription(desc: RTCSessionDescriptionInit) {
		this.remoteDescription = desc as RTCSessionDescription;
		// Simulate ICE + DTLS completing shortly after answer is set
		setTimeout(() => {
			this.connectionState = 'connected';
			this.dispatchEvent('connectionstatechange', new Event('connectionstatechange'));
		}, 0);
	}

	close() {
		this.connectionState = 'closed';
	}

	simulateIceCandidate(candidate: RTCIceCandidate | null) {
		const event = Object.assign(new Event('icecandidate'), { candidate });
		this.dispatchEvent('icecandidate', event);
	}

	simulateIceGatheringComplete() {
		this.iceGatheringState = 'complete';
		this.dispatchEvent('icegatheringstatechange', new Event('icegatheringstatechange'));
		this.simulateIceCandidate(null);
	}

	simulateTrack(kind: 'audio' | 'video') {
		const track = {
			kind,
			stop: vi.fn(),
			id: `mock-${kind}-track`,
		} as unknown as MediaStreamTrack;
		const stream = { id: 'mock-stream' } as MediaStream;
		const event = Object.assign(new Event('track'), { track, streams: [stream] });
		this.dispatchEvent('track', event);
	}
}

class MockRTCRtpTransceiver {
	direction: RTCRtpTransceiverDirection;
	sender: MockRTCRtpSender;

	constructor(sender: MockRTCRtpSender, init?: RTCRtpTransceiverInit) {
		this.sender = sender;
		this.direction = init?.direction ?? 'sendrecv';
	}
}

class MockRTCRtpReceiver {
	track: MediaStreamTrack;
	constructor(kind: string) {
		this.track = { kind, stop: vi.fn(), id: `receiver-${kind}` } as unknown as MediaStreamTrack;
	}
}

// ---------------------------------------------------------------------------
// MediaStream mock
// ---------------------------------------------------------------------------

class MockMediaStream {
	id = 'mock-stream';
	private tracks: MediaStreamTrack[] = [];

	constructor(tracks?: MediaStreamTrack[]) {
		if (tracks) this.tracks = [...tracks];
	}

	addTrack(track: MediaStreamTrack) {
		this.tracks.push(track);
	}

	removeTrack(track: MediaStreamTrack) {
		this.tracks = this.tracks.filter((t) => t !== track);
	}

	getTracks() {
		return [...this.tracks];
	}

	getAudioTracks() {
		return this.tracks.filter((t) => t.kind === 'audio');
	}

	getVideoTracks() {
		return this.tracks.filter((t) => t.kind === 'video');
	}
}

// ---------------------------------------------------------------------------
// Install globals
// ---------------------------------------------------------------------------

vi.stubGlobal('RTCPeerConnection', MockRTCPeerConnection);
vi.stubGlobal('MediaStream', MockMediaStream);

// Export for tests that need direct access
export { MockRTCPeerConnection, MockRTCRtpSender };

// ---------------------------------------------------------------------------
// Shared SDP fixtures
// ---------------------------------------------------------------------------

export const MOCK_SDP_OFFER = [
	'v=0',
	'o=- 123 2 IN IP4 127.0.0.1',
	's=-',
	't=0 0',
	'a=group:BUNDLE audio video',
	'm=audio 9 UDP/TLS/RTP/SAVPF 111 103 104',
	'c=IN IP4 0.0.0.0',
	'a=rtcp:9 IN IP4 0.0.0.0',
	'a=rtpmap:111 opus/48000/2',
	'a=rtpmap:103 ISAC/16000',
	'a=rtpmap:104 ISAC/32000',
	'a=fmtp:111 minptime=10;useinbandfec=1',
	'a=sendonly',
	'm=video 9 UDP/TLS/RTP/SAVPF 96 97 98 99',
	'c=IN IP4 0.0.0.0',
	'a=rtcp:9 IN IP4 0.0.0.0',
	'a=rtpmap:96 VP8/90000',
	'a=rtpmap:97 rtx/90000',
	'a=fmtp:97 apt=96',
	'a=rtpmap:98 H264/90000',
	'a=rtpmap:99 rtx/90000',
	'a=fmtp:99 apt=98',
	'a=sendonly',
	'',
].join('\r\n');

export const MOCK_SDP_ANSWER = [
	'v=0',
	'o=- 456 2 IN IP4 127.0.0.1',
	's=-',
	't=0 0',
	'a=group:BUNDLE audio video',
	'm=audio 9 UDP/TLS/RTP/SAVPF 111',
	'c=IN IP4 0.0.0.0',
	'a=rtpmap:111 opus/48000/2',
	'a=recvonly',
	'm=video 9 UDP/TLS/RTP/SAVPF 96',
	'c=IN IP4 0.0.0.0',
	'a=rtpmap:96 VP8/90000',
	'a=recvonly',
	'',
].join('\r\n');
