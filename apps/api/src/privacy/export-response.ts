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
 * Stream a prepared export into `body` and settle once both the archive and
 * the response are finished. It resolves `true` only when every byte reached
 * the client; an abort or a source failure after the headers resolves
 * `false`, and the short-lived spool is removed either way.
 */
export function pumpExport(
  prepared: PreparedSubjectExport,
  response: Writable,
): { body: PassThrough; delivered: Promise<boolean> } {
  const body = new PassThrough();
  // A client that goes away stops reading; end the archive instead of waiting.
  response.once("close", () => {
    if (!response.writableFinished) body.destroy(new Error("export client disconnected"));
  });
  const written = prepared.write(body);
  const delivered = Promise.allSettled([written, finished(response)]).then(
    async ([archive, sent]) => {
      await prepared.dispose();
      const ok = archive.status === "fulfilled" && sent.status === "fulfilled";
      if (!ok) body.destroy();
      return ok;
    },
  );
  return { body, delivered };
}
