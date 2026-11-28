import { PassThrough, type Writable } from "node:stream";
import { finished } from "node:stream/promises";
import type { PreparedSubjectExport } from "./subject-export.js";

/** Response headers for an export. The archive is streamed, so there is no
 * Content-Length, and no cache may keep a copy. */
export function exportResponseHeaders(filename: string): Record<string, string> {
  return {
    "content-type": "application/zip",
    "content-disposition": `attachment; filename="${filename}"`,
    "cache-control": "private, no-store",
    pragma: "no-cache",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  };
}

/**
 * Longest time the client may take no bytes before the download is ended. The
 * archive is written as fast as the client reads, so a healthy download never
 * pauses this long; it matches the request-body deadline.
 */
export const EXPORT_IDLE_MS = 60_000;

/**
 * Longest one download may run. The archive holds at most about 4 GB (the
 * 2 GB OpenMapX source spool plus the 2 GB managed timeline limit), which
 * still arrives within the hour at about 10 Mbit/s; a typical account is far
 * smaller. It ends a client that keeps an export slot by reading a trickle.
 */
export const EXPORT_TOTAL_MS = 60 * 60_000;

export interface ExportStreamLimits {
  idleMs?: number;
  totalMs?: number;
}

/** The download was ended because the client stopped reading or took too long. */
export class ExportDeadlineError extends Error {
  constructor(readonly deadline: "idle" | "total") {
    super(
      deadline === "idle"
        ? "export client stopped reading"
        : "export exceeded its longest download time",
    );
    this.name = "ExportDeadlineError";
  }
}

/** Counts a chunk as progress once the response side has taken it. */
class ProgressPassThrough extends PassThrough {
  constructor(private readonly onProgress: () => void) {
    super();
  }

  override read(size?: number): ReturnType<PassThrough["read"]> {
    const chunk = super.read(size);
    if (chunk !== null) this.onProgress();
    return chunk;
  }
}

/**
 * Stream a prepared export into `body` and settle once both the archive and
 * the response are finished. It resolves `true` only when every byte reached
 * the client; an abort, a source failure or a missed deadline after the
 * headers resolves `false`, and the short-lived spool is removed either way.
 * The deadlines end the stream itself, so whatever the caller holds for the
 * download is released only once the download has really stopped.
 */
export function pumpExport(
  prepared: Pick<PreparedSubjectExport, "filename" | "write" | "dispose">,
  response: Writable,
  limits: ExportStreamLimits = {},
): { body: PassThrough; delivered: Promise<boolean> } {
  const idleMs = limits.idleMs ?? EXPORT_IDLE_MS;
  const totalMs = limits.totalMs ?? EXPORT_TOTAL_MS;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const cut = (error: ExportDeadlineError) => {
    body.destroy(error);
    // Closing the connection settles the response even when the client never
    // reads again; the reason travels with the archive stream.
    response.destroy();
  };
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => cut(new ExportDeadlineError("idle")), idleMs);
    idleTimer.unref();
  };
  const body = new ProgressPassThrough(armIdle);
  armIdle();
  const totalTimer = setTimeout(() => cut(new ExportDeadlineError("total")), totalMs);
  totalTimer.unref();
  const stopTimers = () => {
    if (idleTimer) clearTimeout(idleTimer);
    clearTimeout(totalTimer);
  };
  body.once("close", stopTimers);

  // A client that goes away stops reading; end the archive instead of waiting.
  response.once("close", () => {
    if (!response.writableFinished) body.destroy(new Error("export client disconnected"));
  });
  // A client that left while the export was being prepared closed the
  // response before the listener above existed; end the archive now.
  if (response.destroyed && !response.writableFinished)
    body.destroy(new Error("export client disconnected"));
  let written: Promise<void>;
  try {
    written = prepared.write(body);
  } catch (error) {
    stopTimers();
    throw error;
  }
  const delivered = Promise.allSettled([written, finished(response)]).then(
    async ([archive, sent]) => {
      stopTimers();
      await prepared.dispose();
      const ok = archive.status === "fulfilled" && sent.status === "fulfilled";
      if (!ok) body.destroy();
      return ok;
    },
  );
  return { body, delivered };
}
