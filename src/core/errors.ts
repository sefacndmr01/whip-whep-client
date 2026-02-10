/**
 * Base error class for all `whip-whep-client` errors.
 *
 * Carries the HTTP `status` code when the error originates from a server
 * response, and a `cause` chain compatible with the native `Error` options
 * added in ES2022.
 */
export class WhipWhepError extends Error {
	/**
	 * HTTP status code from the server response, when applicable.
	 * `undefined` for local errors (network failure, timeout, etc.).
	 */
	readonly status: number | undefined;

	constructor(message: string, options?: { status?: number; cause?: unknown }) {
		super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
		this.name = 'WhipWhepError';
		this.status = options?.status;

		// Maintain correct prototype chain in transpiled environments.
		Object.setPrototypeOf(this, new.target.prototype);
	}
}

/** Thrown by `WHIPClient` when an error occurs during publishing. */
export class WHIPError extends WhipWhepError {
	constructor(message: string, options?: { status?: number; cause?: unknown }) {
		super(message, options);
		this.name = 'WHIPError';
		Object.setPrototypeOf(this, new.target.prototype);
	}
}

/** Thrown by `WHEPClient` when an error occurs during viewing. */
export class WHEPError extends WhipWhepError {
	constructor(message: string, options?: { status?: number; cause?: unknown }) {
		super(message, options);
		this.name = 'WHEPError';
		Object.setPrototypeOf(this, new.target.prototype);
	}
}

/** Thrown when a timed operation exceeds its deadline. */
export class TimeoutError extends WhipWhepError {
	constructor(timeoutMs: number, message = `SDP exchange timed out after ${timeoutMs}ms`) {
		super(message);
		this.name = 'TimeoutError';
		Object.setPrototypeOf(this, new.target.prototype);
	}
}

/**
 * Thrown when a method is called on a client that is not in the expected
 * lifecycle state (e.g. calling `publish()` on a connected client).
 */
export class InvalidStateError extends WhipWhepError {
	constructor(message: string) {
		super(message);
		this.name = 'InvalidStateError';
		Object.setPrototypeOf(this, new.target.prototype);
	}
}
