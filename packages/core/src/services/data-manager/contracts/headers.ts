import z from "zod/v4";
/** Header names are normalized to lowercase; values describe the HTTP wire. */
export const ndjsonResponseHeadersSchema = z.object({
  "content-type": z.string().regex(/^application\/x-ndjson(?:;|$)/i),
  "cache-control": z.literal("no-cache"),
  "x-accel-buffering": z.literal("no"),
});
export const immutableCacheHeadersSchema = z.object({
  "cache-control": z.literal("public, max-age=31536000, immutable"),
});
export const glyphResponseHeadersSchema = immutableCacheHeadersSchema.extend({
  "content-type": z.literal("application/x-protobuf"),
  "content-length": z.string().regex(/^\d+$/),
});
export const archiveResponseHeadersSchema = immutableCacheHeadersSchema.extend({
  "accept-ranges": z.literal("bytes"),
  "content-type": z.literal("application/vnd.pmtiles"),
  "content-length": z.string().regex(/^\d+$/),
  etag: z.string().regex(/^sha256-[0-9a-f]{64}$/),
});
export const partialArchiveResponseHeadersSchema = archiveResponseHeadersSchema.extend({
  "content-range": z.string().regex(/^bytes \d+-\d+\/\d+$/),
});
export const unsatisfiableArchiveResponseHeadersSchema = z.object({
  "content-range": z.string().regex(/^bytes \*\/\d+$/),
  "accept-ranges": z.literal("bytes"),
  etag: z.string().regex(/^sha256-[0-9a-f]{64}$/),
});
export const retryAfterHeadersSchema = z.object({ "retry-after": z.literal("30") });
export const uncachedResponseHeadersSchema = z.object({ "cache-control": z.literal("no-store") });
export const coverageResponseHeadersSchema = z.object({
  "cache-control": z.literal("private, no-store"),
  pragma: z.literal("no-cache"),
});
export const relayResponseHeadersSchema = z.object({
  "cache-control": z.literal("no-store"),
  pragma: z.literal("no-cache"),
  "referrer-policy": z.literal("no-referrer"),
});
export const relaySuccessResponseHeadersSchema = relayResponseHeadersSchema.extend({
  "content-type": z.string().min(1),
  "content-length": z.string().regex(/^\d+$/),
});
