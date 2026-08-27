import { Readable, Transform } from "node:stream";

export const MAX_VECTOR_TILE_BYTES = 2 * 1024 * 1024;
export const MAX_RASTER_TILE_BYTES = 8 * 1024 * 1024;

export const VECTOR_TILE_MEDIA_TYPES = [
  "application/vnd.mapbox-vector-tile",
  "application/x-protobuf",
  "application/octet-stream",
] as const;

export const RASTER_IMAGE_MEDIA_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "application/octet-stream",
] as const;

export interface BoundedBinaryResponseOptions {
  maxBytes: number;
  allowedContentTypes?: readonly string[];
  fallbackContentType?: string;
  label?: string;
}

export interface BoundedBinaryProxy {
  body: Readable;
  contentType: string;
}

function validateOptions(response: Response, options: BoundedBinaryResponseOptions): string {
  if (!Number.isFinite(options.maxBytes) || options.maxBytes <= 0) {
    throw new Error("binary response maxBytes must be positive and finite");
  }
  const label = options.label ?? "binary response";
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > options.maxBytes) {
    throw new Error(`${label} too large (declared ${declared} > ${options.maxBytes} bytes)`);
  }
  const contentType =
    response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ??
    options.fallbackContentType;
  if (!contentType) throw new Error(`${label} did not declare a content type`);
  if (options.allowedContentTypes && !options.allowedContentTypes.includes(contentType)) {
    throw new Error(`${label} has disallowed content type ${contentType}`);
  }
  if (!response.body) throw new Error(`${label} has no body stream`);
  return contentType;
}

export function createBoundedBinaryProxyStream(
  response: Response,
  options: BoundedBinaryResponseOptions,
): BoundedBinaryProxy {
  const contentType = validateOptions(response, options);
  const label = options.label ?? "binary response";
  let total = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      total += chunk.byteLength;
      if (total > options.maxBytes) {
        callback(new Error(`${label} too large (exceeded ${options.maxBytes} bytes)`));
        return;
      }
      callback(null, chunk);
    },
  });
  const source = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
  let sourceEnded = false;
  source.once("end", () => {
    sourceEnded = true;
  });
  source.on("error", (error) => limiter.destroy(error));
  limiter.on("error", () => source.destroy());
  // Fastify destroys a response stream without an error when the client
  // disconnects. Propagate that normal downstream close upstream as well;
  // otherwise the fetch body keeps reading until EOF or its deadline.
  limiter.on("close", () => {
    if (!sourceEnded && !source.destroyed) source.destroy();
  });
  source.pipe(limiter);
  return { body: limiter, contentType };
}

export async function readBoundedBinaryResponse(
  response: Response,
  options: BoundedBinaryResponseOptions,
): Promise<{ data: Buffer; contentType: string }> {
  const { body, contentType } = createBoundedBinaryProxyStream(response, options);
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return { data: Buffer.concat(chunks), contentType };
}
