import { PassThrough, type Readable } from "node:stream";

class InvalidUpstreamResponseError extends Error {
  readonly statusCode = 502;
}

class NormalizedUpstreamResponseStream extends PassThrough {
  readonly #source: Readable;
  readonly #publicMessage: string;
  #started = false;

  constructor(source: Readable, publicMessage: string) {
    super();
    this.#source = source;
    this.#publicMessage = publicMessage;
  }

  readonly #onSourceError = () => {
    this.destroy(new InvalidUpstreamResponseError(this.#publicMessage));
  };

  override _read(size: number): void {
    if (!this.#started) {
      this.#started = true;
      if (this.#source.errored) {
        queueMicrotask(this.#onSourceError);
      } else if (this.#source.destroyed) {
        this.end();
      } else {
        this.#source.once("error", this.#onSourceError);
        this.#source.pipe(this);
      }
    }
    super._read(size);
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.#source.off("error", this.#onSourceError);
    if (!this.#source.destroyed) this.#source.destroy();
    super._destroy(error, callback);
  }
}

export function discardUpstreamResponse(response: Response): void {
  if (!response.body) return;
  void response.body.cancel().catch(() => undefined);
}

/**
 * Replace provider stream errors with a fixed public error before Fastify
 * commits response headers. Once bytes have started flowing, Fastify closes
 * the downstream connection and this wrapper still tears down the provider
 * stream through its direct destroy path.
 */
export function normalizeUpstreamResponseStream(body: Readable, publicMessage: string): Readable {
  return new NormalizedUpstreamResponseStream(body, publicMessage);
}
