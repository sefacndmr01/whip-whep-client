/**
 * ICE trickle helpers.
 *
 * Collects ICE candidates emitted by an `RTCPeerConnection` and forwards
 * them to the server via HTTP PATCH (per the WHIP / WHEP trickle-ICE
 * extension defined in the respective RFCs).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Controls when gathered ICE candidates are dispatched to the server.
 *
 * - `'end-of-candidates'` – buffer all candidates and send a single PATCH
 *   once ICE gathering is complete. Maximises server compatibility.
 * - `'immediate'` – send each candidate individually as soon as it arrives.
 *   Reduces latency but may result in many small PATCH requests.
 */
export type IceTrickleMode = 'end-of-candidates' | 'immediate';

export interface IceTrickleOptions {
	/**
	 * Dispatch mode. Defaults to `'end-of-candidates'`.
	 */
	mode?: IceTrickleMode;

	/**
	 * Called when one or more candidates should be sent to the server.
	 * The host is responsible for making the PATCH request.
	 */
	onCandidates: (candidates: RTCIceCandidate[]) => Promise<void>;

	/**
	 * Optional callback invoked when ICE gathering is complete regardless
	 * of whether any candidates were gathered.
	 */
	onGatheringComplete?: () => void;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Subscribe to ICE candidate events on `pc` and forward gathered candidates
 * via `options.onCandidates`.
 *
 * @returns A cleanup function that removes the attached event listeners.
 */
export function setupIceTrickle(pc: RTCPeerConnection, options: IceTrickleOptions): () => void {
	const { mode = 'end-of-candidates', onCandidates, onGatheringComplete } = options;
	const buffer: RTCIceCandidate[] = [];

	const handleCandidate = (event: RTCPeerConnectionIceEvent): void => {
		if (event.candidate === null) {
			flushBuffer();
			return;
		}

		if (mode === 'immediate') {
			void onCandidates([event.candidate]);
		} else {
			buffer.push(event.candidate);
		}
	};

	const handleGatheringStateChange = (): void => {
		if (pc.iceGatheringState !== 'complete') return;

		flushBuffer();
		onGatheringComplete?.();
	};

	const flushBuffer = (): void => {
		if (mode !== 'end-of-candidates' || buffer.length === 0) return;
		void onCandidates([...buffer]);
		buffer.length = 0;
	};

	pc.addEventListener('icecandidate', handleCandidate);
	pc.addEventListener('icegatheringstatechange', handleGatheringStateChange);

	return () => {
		pc.removeEventListener('icecandidate', handleCandidate);
		pc.removeEventListener('icegatheringstatechange', handleGatheringStateChange);
	};
}

/**
 * Wait for ICE gathering to reach the `'complete'` state on `pc`.
 *
 * Resolves immediately when `iceGatheringState` is already `'complete'`.
 * Rejects after `timeoutMs` milliseconds (default 5 000 ms).
 */
export function waitForIceGathering(pc: RTCPeerConnection, timeoutMs = 5_000): Promise<void> {
	if (pc.iceGatheringState === 'complete') return Promise.resolve();

	return new Promise<void>((resolve, reject) => {
		let done = false;

		const timer = setTimeout(() => {
			if (done) return;
			done = true;
			cleanup();
			reject(new Error(`ICE gathering timed out after ${timeoutMs}ms`));
		}, timeoutMs);

		const handler = (): void => {
			if (pc.iceGatheringState !== 'complete' || done) return;
			done = true;
			cleanup();
			resolve();
		};

		const cleanup = (): void => {
			clearTimeout(timer);
			pc.removeEventListener('icegatheringstatechange', handler);
		};

		pc.addEventListener('icegatheringstatechange', handler);
	});
}
