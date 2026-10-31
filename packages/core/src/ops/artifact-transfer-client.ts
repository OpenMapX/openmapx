import { randomUUID } from "node:crypto";
import {
  type ArtifactStageClaim,
  type TransferPurpose,
  type TransferStage,
  transferStageSchema,
} from "./artifact-transfer";
import { issueArtifactStreamCapability } from "./artifact-transfer-capability";
export type ArtifactStageStreamInput = {
  stageId: string;
  ownerId: string;
  purpose: TransferPurpose;
  signal?: AbortSignal;
  executionDeadlineAt: string;
};
export class ArtifactStageTransportError extends Error {
  constructor(readonly status: number) {
    super("Artifact transfer failed; inspect the retained stage before retrying");
    this.name = "ArtifactStageTransportError";
  }
}
async function boundedJson(response: Response): Promise<unknown> {
  if (response.headers.get("Content-Type")?.split(";")[0] !== "application/json")
    throw new ArtifactStageTransportError(503);
  const reader = response.body?.getReader();
  if (!reader) throw new ArtifactStageTransportError(503);
  let text = "",
    bytes = 0;
  const decoder = new TextDecoder();
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 65536) throw new ArtifactStageTransportError(503);
      text += decoder.decode(part.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export async function withArtifactStream<T>(
  options: {
    baseUrl: string;
    token: string;
    fetch: typeof globalThis.fetch;
    now: number;
    parentSignal?: AbortSignal;
    stage: TransferStage;
    input: ArtifactStageStreamInput & { claim?: ArtifactStageClaim };
    body?: ReadableStream<Uint8Array>;
    contentLength?: number;
  },
  consume?: (input: {
    body: ReadableStream<Uint8Array>;
    signal: AbortSignal;
    headers: Headers;
  }) => Promise<T>,
): Promise<T | TransferStage> {
  const { stage, input } = options;
  const requested = Date.parse(input.executionDeadlineAt);
  const deadlineAt = Math.min(requested, options.now + 72 * 3600_000, Date.parse(stage.expiresAt));
  if (!Number.isSafeInteger(deadlineAt) || deadlineAt <= options.now)
    throw new ArtifactStageTransportError(410);
  const controller = new AbortController();
  const signals = [input.signal, options.parentSignal].filter((s): s is AbortSignal => !!s);
  const abort = () => controller.abort(signals.find((s) => s.aborted)?.reason);
  for (const signal of signals) {
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  }
  const timer = setTimeout(() => controller.abort(), deadlineAt - options.now);
  timer.unref?.();
  let idle: ReturnType<typeof setTimeout> | undefined;
  const touch = () => {
    clearTimeout(idle);
    idle = setTimeout(() => controller.abort(), 5 * 60_000);
    idle.unref?.();
  };
  touch();
  let response: Response | undefined;
  const readers: Array<ReadableStreamDefaultReader<Uint8Array>> = [];
  let downloadEof = false;
  const ownBody = (
    body: ReadableStream<Uint8Array>,
    expected: number | undefined,
    isDownload = false,
  ) => {
    const reader = body.getReader();
    readers.push(reader);
    let count = 0;
    return new ReadableStream<Uint8Array>(
      {
        pull: async (destination) => {
          try {
            controller.signal.throwIfAborted();
            const part = await reader.read();
            controller.signal.throwIfAborted();
            if (part.done) {
              if (expected !== undefined && count !== expected)
                throw new ArtifactStageTransportError(422);
              if (isDownload) downloadEof = true;
              destination.close();
              return;
            }
            count += part.value.byteLength;
            if (
              part.value.byteLength > 8 * 1024 ** 2 ||
              !Number.isSafeInteger(count) ||
              (expected !== undefined && count > expected)
            )
              throw new ArtifactStageTransportError(413);
            touch();
            destination.enqueue(part.value);
          } catch (error) {
            destination.error(error);
            controller.abort(error);
          }
        },
        cancel: (reason) => reader.cancel(reason),
      },
      { highWaterMark: 0 },
    );
  };
  const stopReaders = () => {
    for (const reader of readers) void reader.cancel(controller.signal.reason).catch(() => {});
  };
  controller.signal.addEventListener("abort", stopReaders, { once: true });
  try {
    const cap = issueArtifactStreamCapability(options.token, {
      version: 1,
      stageId: stage.stageId,
      ownerId: input.ownerId,
      purpose: input.purpose,
      direction: options.body ? "upload" : "download",
      byteCap: options.body
        ? (options.contentLength ??
          (input.purpose === "integration-artifact"
            ? 200 * 1024 ** 2
            : input.purpose === "instance-migration"
              ? 64 * 1024 ** 2
              : 1024 ** 4))
        : stage.bytes,
      ...(input.claim ? { claim: input.claim } : {}),
      attemptId: randomUUID(),
      issuedAt: options.now,
      expiresAt: options.now + 60000,
      deadlineAt,
    });
    controller.signal.throwIfAborted();
    response = await options.fetch(
      `${options.baseUrl}/v1/artifact-transfers/${stage.stageId}/content`,
      {
        method: options.body ? "PUT" : "GET",
        headers: {
          Authorization: `Bearer ${options.token}`,
          "x-openmapx-artifact-capability": cap,
          ...(options.body
            ? {
                "Content-Type": "application/octet-stream",
                ...(options.contentLength === undefined
                  ? {}
                  : { "Content-Length": String(options.contentLength) }),
              }
            : {}),
        },
        body: options.body ? ownBody(options.body, options.contentLength) : undefined,
        signal: controller.signal,
        redirect: "error",
        ...(options.body ? { duplex: "half" } : {}),
      } as RequestInit,
    );
    if (!response.ok) {
      await boundedJson(response);
      throw new ArtifactStageTransportError(response.status);
    }
    if (options.body) {
      const result = transferStageSchema.parse(await boundedJson(response));
      if (
        result.stageId !== stage.stageId ||
        result.purpose !== stage.purpose ||
        result.state !== "uploaded"
      )
        throw new ArtifactStageTransportError(503);
      return result;
    }
    const headers = response.headers;
    if (
      headers.get("Content-Type")?.split(";")[0] !== "application/octet-stream" ||
      headers.get("Content-Length") !== String(stage.bytes) ||
      headers.get("X-Artifact-Sha256") !== stage.sha256 ||
      !response.body ||
      !consume
    )
      throw new ArtifactStageTransportError(503);
    const result = await consume({
      body: ownBody(response.body, stage.bytes, true),
      headers,
      signal: controller.signal,
    });
    controller.signal.throwIfAborted();
    if (!downloadEof) throw new ArtifactStageTransportError(409);
    return result;
  } finally {
    try {
      for (const reader of readers) {
        await reader.cancel(controller.signal.reason).catch(() => {});
        reader.releaseLock();
      }
      if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
    } finally {
      clearTimeout(timer);
      clearTimeout(idle);
      controller.signal.removeEventListener("abort", stopReaders);
      for (const signal of signals) signal.removeEventListener("abort", abort);
    }
  }
}
