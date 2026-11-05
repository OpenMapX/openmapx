import { afterEach, expect, it, vi } from "vitest";
import type { TransferStage } from "./artifact-transfer";
import {
  issueArtifactStreamCapability,
  verifyArtifactStreamCapability,
} from "./artifact-transfer-capability";
import { ArtifactStageTransportError, withArtifactStream } from "./artifact-transfer-client";

const stage: TransferStage = {
  stageId: "91a78b3e-208b-4ba4-9ddf-870fbdf1da22",
  purpose: "prepared-artifact",
  direction: "download",
  state: "ready",
  bytes: 2,
  sha256: "a".repeat(64),
  expiresAt: "2099-01-01T00:00:00.000Z",
  cleanup: "pending",
};
afterEach(() => vi.useRealTimers());
it.each(["abort", "deadline"])("raw ops download owns sink cleanup through %s", async (mode) => {
  vi.useFakeTimers();
  let entered = false,
    cleaned = false,
    canceled = false,
    settled = false;
  let release = () => {};
  const cleanup = new Promise<void>((resolve) => {
    release = resolve;
  });
  const abort = new AbortController();
  const source = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array([0, 255]));
    },
    cancel() {
      canceled = true;
    },
  });
  const pending = withArtifactStream(
    {
      baseUrl: "http://agent",
      token: "a".repeat(43),
      fetch: vi.fn().mockResolvedValue(
        new Response(source, {
          headers: {
            "content-type": "application/octet-stream",
            "content-length": "2",
            "x-artifact-sha256": stage.sha256!,
          },
        }),
      ),
      now: Date.now(),
      stage,
      input: {
        stageId: stage.stageId,
        ownerId: "admin",
        purpose: stage.purpose,
        signal: abort.signal,
        executionDeadlineAt: new Date(Date.now() + 20).toISOString(),
      },
    },
    async ({ body, signal }) => {
      const reader = body.getReader();
      try {
        await reader.read();
        entered = true;
        await new Promise<void>((resolve) =>
          signal.addEventListener(
            "abort",
            () => {
              void cleanup.then(() => {
                cleaned = true;
                resolve();
              });
            },
            { once: true },
          ),
        );
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
    },
  )
    .catch((error) => error)
    .finally(() => {
      settled = true;
    });
  await vi.advanceTimersByTimeAsync(0);
  expect(entered).toBe(true);
  if (mode === "abort") abort.abort();
  else await vi.advanceTimersByTimeAsync(21);
  await vi.advanceTimersByTimeAsync(0);
  expect(settled).toBe(false);
  release();
  await vi.advanceTimersByTimeAsync(0);
  expect(await pending).toBeInstanceOf(Error);
  expect(cleaned).toBe(true);
  expect(canceled).toBe(true);
  expect(source.locked).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});
it("refuses early callback completion and bounds error JSON", async () => {
  const input = {
    stageId: stage.stageId,
    ownerId: "admin",
    purpose: stage.purpose,
    executionDeadlineAt: new Date(Date.now() + 10000).toISOString(),
  };
  const options = { baseUrl: "http://agent", token: "a".repeat(43), now: Date.now(), stage, input };
  await expect(
    withArtifactStream(
      {
        ...options,
        fetch: vi.fn().mockResolvedValue(
          new Response(new Uint8Array([0, 255]), {
            headers: {
              "content-type": "application/octet-stream",
              "content-length": "2",
              "x-artifact-sha256": stage.sha256!,
            },
          }),
        ),
      },
      async () => {},
    ),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    withArtifactStream(
      {
        ...options,
        fetch: vi.fn().mockResolvedValue(
          new Response("x".repeat(65537), {
            status: 409,
            headers: { "content-type": "application/json" },
          }),
        ),
      },
      async () => {},
    ),
  ).rejects.toBeInstanceOf(ArtifactStageTransportError);
});
it("domain-separates the short-lived capability and rejects key substitution, expiry and alteration", () => {
  const now = Date.now();
  const input = {
    version: 1 as const,
    stageId: stage.stageId,
    ownerId: "admin",
    purpose: stage.purpose,
    direction: "download" as const,
    byteCap: 2,
    attemptId: "81a78b3e-208b-4ba4-9ddf-870fbdf1da22",
    issuedAt: now,
    expiresAt: now + 60000,
    deadlineAt: now + 100000,
  };
  const cap = issueArtifactStreamCapability("token", input);
  expect(verifyArtifactStreamCapability("token", cap, now)).toEqual(input);
  expect(() => verifyArtifactStreamCapability("other", cap, now)).toThrow();
  expect(() => verifyArtifactStreamCapability("token", cap, now + 60001)).toThrow();
  expect(() =>
    verifyArtifactStreamCapability("token", cap.replace("atcap1.", "pbcap1."), now),
  ).toThrow();
});
