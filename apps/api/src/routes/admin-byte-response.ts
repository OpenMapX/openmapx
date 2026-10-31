import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import type { ApiResponseContract } from "@openmapx/core/api-contracts";
import type { FastifyReply } from "fastify";

const contracts = new WeakMap<FastifyReply, Record<number, ApiResponseContract>>();
const sending = new WeakSet<FastifyReply>();
export function bindAdminByteResponse(
  reply: FastifyReply,
  responses: Record<number, ApiResponseContract>,
): void {
  contracts.set(reply, responses);
}
export function isAdminByteResponse(reply: FastifyReply): boolean {
  return sending.has(reply);
}
/** Sole canonical byte-send adapter. Its promise owns destination completion/abort. */
export async function sendAdminByteResponse(
  reply: FastifyReply,
  input: {
    body: ReadableStream<Uint8Array>;
    signal: AbortSignal;
    headers: Headers;
    status?: number;
  },
): Promise<void> {
  const status = input.status ?? 200;
  const contract = contracts.get(reply)?.[status];
  if (
    contract?.kind !== "bytes" ||
    input.headers.get("content-type")?.split(";")[0] !== contract.mediaType ||
    (contract.headers && !contract.headers.safeParse(Object.fromEntries(input.headers)).success)
  )
    throw Error("Invalid administration byte response");
  input.signal.throwIfAborted();
  reply.code(status);
  input.headers.forEach((v, k) => {
    reply.header(k, v);
  });
  sending.add(reply);
  const source = Readable.fromWeb(
    input.body as import("node:stream/web").ReadableStream<Uint8Array>,
    { signal: input.signal },
  );
  const completion = finished(reply.raw, { signal: input.signal, cleanup: true });
  const response = reply.send(source);
  try {
    await Promise.all([completion, response]);
  } finally {
    source.destroy();
    sending.delete(reply);
  }
}
