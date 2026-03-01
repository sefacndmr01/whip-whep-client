/**
 * Browser media utilities.
 *
 * Convenience wrappers around `getUserMedia` and `getDisplayMedia` that apply
 * sensible defaults and set `contentHint` values so the WebRTC encoder can
 * choose the most appropriate settings for the content type.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Options for `getScreenStream`.
 */
export interface ScreenStreamOptions {
	/**
	 * Capture system audio along with the screen.
	 *
	 * Browser support varies: Chrome supports tab and system audio; Safari and
	 * Firefox do not support system audio capture via `getDisplayMedia`.
	 * Defaults to `false`.
	 */
	audio?: boolean;

	/**
	 * Override individual video constraints merged on top of the defaults
	 * (`{ width: 1920, height: 1080, frameRate: 30 }`).
	 */
	videoConstraints?: MediaTrackConstraints;
}

/**
 * Options for `getUserStream`.
 */
export interface UserStreamOptions {
	/** Request audio. Defaults to `true`. */
	audio?: boolean | MediaTrackConstraints;
	/** Request video. Defaults to `true`. */
	video?: boolean | MediaTrackConstraints;
	/**
	 * Hint to set on the video track.
	 * - `'motion'` – optimise for fast movement (default for camera).
	 * - `'detail'` – optimise for sharpness (slides, documents).
	 */
	videoContentHint?: 'motion' | 'detail' | 'text' | '';
	/**
	 * Hint to set on the audio track.
	 * - `'speech'` – optimise for voice (default).
	 * - `'music'` – optimise for music / wide-band content.
	 */
	audioContentHint?: 'speech' | 'speech-recognition' | 'music' | '';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Request a screen / window / tab capture stream using `getDisplayMedia`.
 *
 * Sets `contentHint = 'detail'` on all video tracks so the encoder can
 * prioritise sharpness over motion smoothness, which is appropriate for
 * most screen-sharing scenarios.
 *
 * @example
 * ```ts
 * import { getScreenStream } from 'whip-whep-client/utils/media';
 *
 * const screen = await getScreenStream({ audio: true });
 * await whipClient.publish(screen);
 * ```
 *
 * @throws `DOMException` with name `'NotAllowedError'` when the user denies
 * the permission prompt.
 */
export async function getScreenStream(options: ScreenStreamOptions = {}): Promise<MediaStream> {
	const { audio = false, videoConstraints = {} } = options;

	const stream = await navigator.mediaDevices.getDisplayMedia({
		video: {
			width: { ideal: 1920 },
			height: { ideal: 1080 },
			frameRate: { ideal: 30 },
			...videoConstraints,
		},
		audio,
	});

	for (const track of stream.getVideoTracks()) {
		track.contentHint = 'detail';
	}

	return stream;
}

/**
 * Request a camera + microphone stream using `getUserMedia`.
 *
 * Applies `contentHint` values that match typical live-streaming use-cases
 * and can be overridden via the `videoContentHint` / `audioContentHint`
 * options.
 *
 * @example
 * ```ts
 * import { getUserStream } from 'whip-whep-client/utils/media';
 *
 * const stream = await getUserStream({ videoContentHint: 'motion' });
 * await whipClient.publish(stream);
 * ```
 *
 * @throws `DOMException` with name `'NotAllowedError'` when the user denies
 * the permission prompt.
 */
export async function getUserStream(options: UserStreamOptions = {}): Promise<MediaStream> {
	const {
		audio = true,
		video = true,
		videoContentHint = 'motion',
		audioContentHint = 'speech',
	} = options;

	const stream = await navigator.mediaDevices.getUserMedia({ audio, video });

	for (const track of stream.getVideoTracks()) {
		track.contentHint = videoContentHint;
	}
	for (const track of stream.getAudioTracks()) {
		track.contentHint = audioContentHint;
	}

	return stream;
}
