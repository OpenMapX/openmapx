import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";
import type { SafeDownloadOptions } from "@openmapx/core/utils/safe-download";
import { afterEach, describe, expect, it, vi } from "vitest";

const undiciLifecycle = vi.hoisted(() => ({
  close: vi.fn().mockResolvedValue(undefined),
  destroy: vi.fn().mockResolvedValue(undefined),
}));
const relayFileLifecycle = vi.hoisted(() => ({
  actualMkdtemp: undefined as typeof import("node:fs/promises")["mkdtemp"] | undefined,
  actualRm: undefined as typeof import("node:fs/promises")["rm"] | undefined,
  mkdtemp: vi.fn(),
  rm: vi.fn(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  relayFileLifecycle.actualMkdtemp = actual.mkdtemp;
  relayFileLifecycle.actualRm = actual.rm;
  relayFileLifecycle.mkdtemp.mockImplementation(actual.mkdtemp);
  relayFileLifecycle.rm.mockImplementation(actual.rm);
  return { ...actual, mkdtemp: relayFileLifecycle.mkdtemp, rm: relayFileLifecycle.rm };
});

vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));
vi.mock("undici", async (importOriginal) => {
  const actual = await importOriginal<typeof import("undici")>();
  return {
    ...actual,
    Agent: vi.fn(function PinnedAgent() {
      return { close: undiciLifecycle.close, destroy: undiciLifecycle.destroy };
    }),
    fetch: vi.fn(),
  };
});

import { lookup as dnsLookup } from "node:dns/promises";
import { fetch as undiciFetch } from "undici";
import {
  OPERATOR_FEED_MAX_BYTES,
  type OperatorFeedRelayAuditEvent,
  OperatorFeedRelayStore,
} from "./operator-feed-relay.js";

const lookupMock = dnsLookup as unknown as ReturnType<typeof vi.fn>;
const undiciFetchMock = undiciFetch as unknown as ReturnType<typeof vi.fn>;
const mkdtempMock = relayFileLifecycle.mkdtemp;
const rmMock = relayFileLifecycle.rm;

afterEach(() => {
  vi.useRealTimers();
  lookupMock.mockReset();
  undiciFetchMock.mockReset();
  undiciLifecycle.close.mockReset();
  undiciLifecycle.close.mockResolvedValue(undefined);
  undiciLifecycle.destroy.mockReset();
  undiciLifecycle.destroy.mockResolvedValue(undefined);
  const actualMkdtemp = relayFileLifecycle.actualMkdtemp;
  const actualRm = relayFileLifecycle.actualRm;
  if (!actualMkdtemp || !actualRm) throw new Error("relay filesystem fixtures are unavailable");
  mkdtempMock.mockReset();
  mkdtempMock.mockImplementation(actualMkdtemp);
  rmMock.mockReset();
  rmMock.mockImplementation(actualRm);
});

function response(options: {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
}): Response {
  const status = options.status ?? 200;
  return {
    status,
    statusText: status === 200 ? "OK" : "Found",
    ok: status >= 200 && status < 300,
    url: "",
    headers: new Headers(options.headers),
    body: new Response(options.body ?? "").body,
  } as unknown as Response;
}

function successfulDownload(body = "operator archive") {
  return async (options: SafeDownloadOptions) => {
    writeFileSync(options.destination, body, { mode: 0o600 });
    return {
      bytesWritten: Buffer.byteLength(body),
      contentType: "application/zip",
      finalUrl: options.url,
    };
  };
}

async function readStream(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitForClose(stream: Readable): Promise<void> {
  if (stream.closed) return;
  await new Promise<void>((resolve) => stream.once("close", resolve));
}

describe("OperatorFeedRelayStore", () => {
  it("creates an unguessable loopback URL without exposing the remote URL", () => {
    const relay = new OperatorFeedRelayStore({ download: successfulDownload() });

    const registration = relay.register({
      runId: "run-a",
      sourceId: "operator:de:demo",
      remoteUrl: new URL("https://operator.example/private/feed.zip?fixture=secret"),
    });

    expect(registration.handle).toMatch(/^[a-f0-9]{64}$/);
    expect(registration.url.origin).toBe("http://127.0.0.1:4000");
    expect(registration.url.pathname).toBe(
      `/internal/transit/operator-feed/${registration.handle}`,
    );
    expect(registration.url.toString()).not.toContain("operator.example");
    expect(registration.url.toString()).not.toContain("fixture=secret");
  });

  it("binds a handle to one run and permits exactly one successful claim", async () => {
    let destination: string | undefined;
    const relay = new OperatorFeedRelayStore({
      maxEntries: 1,
      download: async (options) => {
        destination = options.destination;
        return successfulDownload()(options);
      },
    });
    const registration = relay.register({
      runId: "run-a",
      sourceId: "operator:de:demo",
      remoteUrl: new URL("https://operator.example/feed.zip"),
    });

    await expect(relay.consume({ handle: registration.handle, runId: "run-b" })).rejects.toThrow(
      /run/i,
    );
    const payload = await relay.consume({ handle: registration.handle, runId: "run-a" });
    expect(destination && existsSync(destination)).toBe(true);
    expect(await readStream(payload.stream)).toEqual(Buffer.from("operator archive"));
    await expect(relay.consume({ handle: registration.handle, runId: "run-a" })).rejects.toThrow(
      /invalid|expired|used/i,
    );
    await payload.release();
    expect(destination && existsSync(destination)).toBe(false);
  });

  it("passes the fixed 512 MiB cap, exact-origin policy, and abort signal to safe-download", async () => {
    let optionsSeen: SafeDownloadOptions | undefined;
    const relay = new OperatorFeedRelayStore({
      download: async (options) => {
        optionsSeen = options;
        return successfulDownload()(options);
      },
    });
    const registration = relay.register({
      runId: "run-a",
      sourceId: "operator:de:demo",
      remoteUrl: new URL("https://operator.example/feed.zip"),
      headers: { Authorization: "Bearer fixture-credential" },
    });

    const payload = await relay.consume({ handle: registration.handle, runId: "run-a" });

    expect(optionsSeen).toMatchObject({
      maxBytes: OPERATOR_FEED_MAX_BYTES,
      credentialPolicy: "same-origin",
      allowedContentTypes: [],
    });
    expect(optionsSeen?.signal).toBeInstanceOf(AbortSignal);
    await payload.release();
  });

  it("fails closed on downloader rejection and never makes the handle reusable", async () => {
    let attempts = 0;
    const relay = new OperatorFeedRelayStore({
      download: async () => {
        attempts += 1;
        throw new Error("private redirect rejected");
      },
    });
    const registration = relay.register({
      runId: "run-a",
      sourceId: "operator:de:demo",
      remoteUrl: new URL("https://operator.example/feed.zip"),
    });

    await expect(relay.consume({ handle: registration.handle, runId: "run-a" })).rejects.toThrow(
      /private redirect rejected/,
    );
    await expect(relay.consume({ handle: registration.handle, runId: "run-a" })).rejects.toThrow(
      /invalid|expired|used/i,
    );
    expect(attempts).toBe(1);
  });

  it("rejects private, redirected-private, and oversized operator targets through safe-download", async () => {
    const privateRelay = new OperatorFeedRelayStore();
    const privateRegistration = privateRelay.register({
      runId: "run-private",
      sourceId: "operator:de:private",
      remoteUrl: new URL("http://127.0.0.1/feed.zip"),
    });
    await expect(
      privateRelay.consume({ handle: privateRegistration.handle, runId: "run-private" }),
    ).rejects.toThrow(/private|internal/i);
    expect(undiciFetchMock).not.toHaveBeenCalled();

    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    undiciFetchMock.mockResolvedValueOnce(
      response({ status: 302, headers: { location: "http://169.254.169.254/latest" } }),
    );
    const redirectRelay = new OperatorFeedRelayStore();
    const redirectRegistration = redirectRelay.register({
      runId: "run-redirect",
      sourceId: "operator:de:redirect",
      remoteUrl: new URL("https://operator.example/feed.zip"),
    });
    await expect(
      redirectRelay.consume({ handle: redirectRegistration.handle, runId: "run-redirect" }),
    ).rejects.toThrow(/private|internal/i);

    lookupMock.mockReset();
    undiciFetchMock.mockReset();
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    undiciFetchMock.mockResolvedValueOnce(response({ body: "x".repeat(32) }));
    const oversizedRelay = new OperatorFeedRelayStore({ maxBytes: 8 });
    const oversizedRegistration = oversizedRelay.register({
      runId: "run-oversized",
      sourceId: "operator:de:oversized",
      remoteUrl: new URL("https://operator.example/feed.zip"),
    });
    await expect(
      oversizedRelay.consume({ handle: oversizedRegistration.handle, runId: "run-oversized" }),
    ).rejects.toThrow(/max size|too large/i);
  });

  it("propagates caller abort into the active remote acquisition and consumes the handle", async () => {
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const relay = new OperatorFeedRelayStore({
      maxEntries: 1,
      download: async (options) => {
        started();
        return await new Promise((_, reject) => {
          options.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
            once: true,
          });
        });
      },
    });
    const registration = relay.register({
      runId: "run-abort",
      sourceId: "operator:de:abort",
      remoteUrl: new URL("https://operator.example/feed.zip"),
    });
    const controller = new AbortController();
    const consuming = relay.consume({
      handle: registration.handle,
      runId: "run-abort",
      signal: controller.signal,
    });
    await startedPromise;
    controller.abort(new Error("fixture canceled"));

    await expect(consuming).rejects.toThrow(/fixture canceled/);
    await expect(
      relay.consume({ handle: registration.handle, runId: "run-abort" }),
    ).rejects.toThrow(/invalid|expired|used/i);
    const replacement = relay.register({
      runId: "run-after-abort",
      sourceId: "operator:de:after-abort",
      remoteUrl: new URL("https://operator.example/after-abort.zip"),
    });
    expect(replacement.handle).toMatch(/^[a-f0-9]{64}$/);
    await relay.endRun("run-after-abort");
  });

  it("expires unused handles and all run payloads deterministically", async () => {
    let now = 1_000;
    let destination: string | undefined;
    const relay = new OperatorFeedRelayStore({
      download: async (options) => {
        destination = options.destination;
        return successfulDownload()(options);
      },
      now: () => now,
      ttlMs: 50,
    });
    const expired = relay.register({
      runId: "run-a",
      sourceId: "operator:de:expired",
      remoteUrl: new URL("https://operator.example/expired.zip"),
    });
    now += 51;
    await expect(relay.consume({ handle: expired.handle, runId: "run-a" })).rejects.toThrow(
      /invalid|expired|used/i,
    );

    const active = relay.register({
      runId: "run-b",
      sourceId: "operator:de:active",
      remoteUrl: new URL("https://operator.example/active.zip"),
    });
    const payload = await relay.consume({ handle: active.handle, runId: "run-b" });
    expect(destination && existsSync(destination)).toBe(true);
    await relay.endRun("run-b");
    expect(payload.stream.destroyed).toBe(true);
    expect(destination && existsSync(destination)).toBe(false);
  });

  it("bounds outstanding registrations before allocating another capability", () => {
    const relay = new OperatorFeedRelayStore({
      download: successfulDownload(),
      maxEntries: 1,
    });
    relay.register({
      runId: "run-a",
      sourceId: "operator:de:first",
      remoteUrl: new URL("https://operator.example/first.zip"),
    });
    expect(() =>
      relay.register({
        runId: "run-a",
        sourceId: "operator:de:second",
        remoteUrl: new URL("https://operator.example/second.zip"),
      }),
    ).toThrow(/capacity/i);
  });

  it("reserves one capacity slot across claim setup under 50 concurrent contenders", async () => {
    let openGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const relay = new OperatorFeedRelayStore({
      maxEntries: 1,
      download: async (options) => {
        await gate;
        return successfulDownload()(options);
      },
    });
    const consumptions: Array<ReturnType<typeof relay.consume>> = [];
    let accepted = 0;
    for (let index = 0; index < 50; index += 1) {
      try {
        const registration = relay.register({
          runId: `run-${index}`,
          sourceId: `operator:de:contender-${index}`,
          remoteUrl: new URL(`https://operator.example/${index}.zip`),
        });
        accepted += 1;
        consumptions.push(relay.consume({ handle: registration.handle, runId: `run-${index}` }));
      } catch {
        // Capacity rejection is the expected outcome for all but one contender.
      }
    }
    openGate?.();
    const settled = await Promise.allSettled(consumptions);
    for (const result of settled) {
      if (result.status === "fulfilled") await result.value.release();
    }

    expect(accepted).toBe(1);
    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  });

  it("allows only one of 50 concurrent claims of the same capability", async () => {
    const relay = new OperatorFeedRelayStore({ maxEntries: 1, download: successfulDownload() });
    const registration = relay.register({
      runId: "run-shared",
      sourceId: "operator:de:shared",
      remoteUrl: new URL("https://operator.example/shared.zip"),
    });

    const settled = await Promise.allSettled(
      Array.from({ length: 50 }, () =>
        relay.consume({ handle: registration.handle, runId: "run-shared" }),
      ),
    );
    const fulfilled = settled.filter((result) => result.status === "fulfilled");
    if (fulfilled[0]?.status === "fulfilled") await fulfilled[0].value.release();

    expect(fulfilled).toHaveLength(1);
    expect(settled.filter((result) => result.status === "rejected")).toHaveLength(49);
  });

  it("releases a reserved slot when materialization setup fails", async () => {
    mkdtempMock.mockRejectedValueOnce(new Error("mkdtemp denied"));
    const relay = new OperatorFeedRelayStore({ maxEntries: 1, download: successfulDownload() });
    const registration = relay.register({
      runId: "run-setup",
      sourceId: "operator:de:setup",
      remoteUrl: new URL("https://operator.example/setup.zip"),
    });

    await expect(
      relay.consume({ handle: registration.handle, runId: "run-setup" }),
    ).rejects.toThrow("mkdtemp denied");
    const replacement = relay.register({
      runId: "run-replacement",
      sourceId: "operator:de:replacement",
      remoteUrl: new URL("https://operator.example/replacement.zip"),
    });
    expect(replacement.handle).toMatch(/^[a-f0-9]{64}$/);
    await relay.endRun("run-replacement");
  });

  it("keeps a cleanup-failed payload owned and makes release retryable", async () => {
    const actualRm = relayFileLifecycle.actualRm;
    if (!actualRm) throw new Error("real rm fixture is unavailable");
    let cleanupAttempts = 0;
    rmMock.mockImplementation(async (path, options) => {
      if (String(path).includes("openmapx-operator-feed-relay-") && cleanupAttempts < 3) {
        cleanupAttempts += 1;
        throw new Error("rm denied");
      }
      return actualRm(path, options);
    });
    let destination: string | undefined;
    const relay = new OperatorFeedRelayStore({
      maxEntries: 1,
      download: async (options) => {
        destination = options.destination;
        return successfulDownload()(options);
      },
    });
    const registration = relay.register({
      runId: "run-cleanup",
      sourceId: "operator:de:cleanup",
      remoteUrl: new URL("https://operator.example/cleanup.zip"),
    });
    const payload = await relay.consume({ handle: registration.handle, runId: "run-cleanup" });

    try {
      await expect(payload.release()).rejects.toThrow(/cleanup/i);
      expect(destination && existsSync(destination)).toBe(true);
      expect(() =>
        relay.register({
          runId: "run-blocked",
          sourceId: "operator:de:blocked",
          remoteUrl: new URL("https://operator.example/blocked.zip"),
        }),
      ).toThrow(/capacity/i);

      await payload.release();
      expect(destination && existsSync(destination)).toBe(false);
      const replacement = relay.register({
        runId: "run-after-cleanup",
        sourceId: "operator:de:after-cleanup",
        remoteUrl: new URL("https://operator.example/after-cleanup.zip"),
      });
      expect(replacement.handle).toMatch(/^[a-f0-9]{64}$/);
      await relay.endRun("run-after-cleanup");
    } finally {
      rmMock.mockImplementation(actualRm);
      if (destination) await actualRm(dirname(destination), { force: true, recursive: true });
    }
  });

  it("preserves a downloader failure while retaining a partial until run cleanup retries", async () => {
    const actualRm = relayFileLifecycle.actualRm;
    if (!actualRm) throw new Error("real rm fixture is unavailable");
    let cleanupAttempts = 0;
    rmMock.mockImplementation(async (path, options) => {
      if (String(path).includes("openmapx-operator-feed-relay-") && cleanupAttempts < 3) {
        cleanupAttempts += 1;
        throw new Error("rm denied");
      }
      return actualRm(path, options);
    });
    let destination: string | undefined;
    const relay = new OperatorFeedRelayStore({
      maxEntries: 1,
      download: async (options) => {
        destination = options.destination;
        writeFileSync(options.destination, "partial", { mode: 0o600 });
        throw new Error("remote acquisition rejected");
      },
    });
    const registration = relay.register({
      runId: "run-partial",
      sourceId: "operator:de:partial",
      remoteUrl: new URL("https://operator.example/partial.zip"),
    });

    try {
      await expect(
        relay.consume({ handle: registration.handle, runId: "run-partial" }),
      ).rejects.toThrow("remote acquisition rejected");
      expect(destination && existsSync(destination)).toBe(true);
      expect(() =>
        relay.register({
          runId: "run-blocked",
          sourceId: "operator:de:blocked",
          remoteUrl: new URL("https://operator.example/blocked.zip"),
        }),
      ).toThrow(/capacity/i);

      await relay.endRun("run-partial");
      expect(destination && existsSync(destination)).toBe(false);
    } finally {
      rmMock.mockImplementation(actualRm);
      if (destination) await actualRm(dirname(destination), { force: true, recursive: true });
    }
  });

  it("retains run cleanup ownership until a failed deletion is retried", async () => {
    const actualRm = relayFileLifecycle.actualRm;
    if (!actualRm) throw new Error("real rm fixture is unavailable");
    let cleanupAttempts = 0;
    rmMock.mockImplementation(async (path, options) => {
      if (String(path).includes("openmapx-operator-feed-relay-") && cleanupAttempts < 3) {
        cleanupAttempts += 1;
        throw new Error("rm denied");
      }
      return actualRm(path, options);
    });
    let destination: string | undefined;
    const relay = new OperatorFeedRelayStore({
      maxEntries: 1,
      download: async (options) => {
        destination = options.destination;
        return successfulDownload()(options);
      },
    });
    const registration = relay.register({
      runId: "run-end-cleanup",
      sourceId: "operator:de:end-cleanup",
      remoteUrl: new URL("https://operator.example/end-cleanup.zip"),
    });
    await relay.consume({ handle: registration.handle, runId: "run-end-cleanup" });

    try {
      await expect(relay.endRun("run-end-cleanup")).rejects.toThrow(/cleanup/i);
      expect(destination && existsSync(destination)).toBe(true);
      await relay.endRun("run-end-cleanup");
      expect(destination && existsSync(destination)).toBe(false);
    } finally {
      rmMock.mockImplementation(actualRm);
      if (destination) await actualRm(dirname(destination), { force: true, recursive: true });
    }
  });

  it("bounds a never-settling stream destroy and retains capacity until close is confirmed", async () => {
    vi.useFakeTimers();
    const relay = new OperatorFeedRelayStore({
      maxEntries: 1,
      download: successfulDownload(Buffer.alloc(256 * 1024, "x").toString()),
    });
    const registration = relay.register({
      runId: "run-stream-cleanup",
      sourceId: "operator:de:stream-cleanup",
      remoteUrl: new URL("https://operator.example/stream-cleanup.zip"),
    });
    const payload = await relay.consume({
      handle: registration.handle,
      runId: "run-stream-cleanup",
    });
    const destroyStarted = deferred();
    let finishDestroy: ((error?: Error | null) => void) | undefined;
    (
      payload.stream as unknown as {
        _destroy(error: Error | null, callback: (error?: Error | null) => void): void;
      }
    )._destroy = (_error, callback) => {
      finishDestroy = callback;
      destroyStarted.resolve();
    };

    let outcome = "pending";
    const release = payload.release().then(
      () => {
        outcome = "resolved";
      },
      () => {
        outcome = "rejected";
      },
    );
    await destroyStarted.promise;
    await vi.advanceTimersByTimeAsync(10_000);

    expect(outcome).toBe("rejected");
    expect(() =>
      relay.register({
        runId: "run-blocked-stream-cleanup",
        sourceId: "operator:de:blocked-stream-cleanup",
        remoteUrl: new URL("https://operator.example/blocked-stream-cleanup.zip"),
      }),
    ).toThrow(/capacity/i);
    finishDestroy?.();
    await release;
    await payload.release();
    const replacement = relay.register({
      runId: "run-after-stream-cleanup",
      sourceId: "operator:de:after-stream-cleanup",
      remoteUrl: new URL("https://operator.example/after-stream-cleanup.zip"),
    });
    expect(replacement.handle).toMatch(/^[a-f0-9]{64}$/);
    await relay.endRun("run-after-stream-cleanup");
  });

  it("bounds a never-settling relay rm and makes release retryable", async () => {
    vi.useFakeTimers();
    const actualRm = relayFileLifecycle.actualRm;
    if (!actualRm) throw new Error("real rm fixture is unavailable");
    const cleanupStarted = deferred();
    rmMock.mockImplementation(async (path, options) => {
      if (String(path).includes("openmapx-operator-feed-relay-")) {
        cleanupStarted.resolve();
        return await new Promise<void>(() => {});
      }
      return actualRm(path, options);
    });
    let destination: string | undefined;
    const relay = new OperatorFeedRelayStore({
      maxEntries: 1,
      download: async (options) => {
        destination = options.destination;
        return successfulDownload()(options);
      },
    });
    const registration = relay.register({
      runId: "run-pending-rm",
      sourceId: "operator:de:pending-rm",
      remoteUrl: new URL("https://operator.example/pending-rm.zip"),
    });
    const payload = await relay.consume({ handle: registration.handle, runId: "run-pending-rm" });

    try {
      let outcome = "pending";
      const release = payload.release().then(
        () => {
          outcome = "resolved";
        },
        () => {
          outcome = "rejected";
        },
      );
      await cleanupStarted.promise;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(outcome).toBe("rejected");
      expect(destination && existsSync(destination)).toBe(true);
      expect(() =>
        relay.register({
          runId: "run-blocked-pending-rm",
          sourceId: "operator:de:blocked-pending-rm",
          remoteUrl: new URL("https://operator.example/blocked-pending-rm.zip"),
        }),
      ).toThrow(/capacity/i);
      await release;

      vi.useRealTimers();
      rmMock.mockImplementation(actualRm);
      await payload.release();
      expect(destination && existsSync(destination)).toBe(false);
    } finally {
      vi.useRealTimers();
      rmMock.mockImplementation(actualRm);
      if (destination) await actualRm(dirname(destination), { force: true, recursive: true });
    }
  });

  it("bounds endRun when relay rm never settles and preserves retry ownership", async () => {
    vi.useFakeTimers();
    const actualRm = relayFileLifecycle.actualRm;
    if (!actualRm) throw new Error("real rm fixture is unavailable");
    const cleanupStarted = deferred();
    rmMock.mockImplementation(async (path, options) => {
      if (String(path).includes("openmapx-operator-feed-relay-")) {
        cleanupStarted.resolve();
        return await new Promise<void>(() => {});
      }
      return actualRm(path, options);
    });
    let destination: string | undefined;
    const relay = new OperatorFeedRelayStore({
      maxEntries: 1,
      download: async (options) => {
        destination = options.destination;
        return successfulDownload()(options);
      },
    });
    const registration = relay.register({
      runId: "run-pending-end",
      sourceId: "operator:de:pending-end",
      remoteUrl: new URL("https://operator.example/pending-end.zip"),
    });
    await relay.consume({ handle: registration.handle, runId: "run-pending-end" });

    try {
      let outcome = "pending";
      const ending = relay.endRun("run-pending-end").then(
        () => {
          outcome = "resolved";
        },
        () => {
          outcome = "rejected";
        },
      );
      await cleanupStarted.promise;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(outcome).toBe("rejected");
      expect(destination && existsSync(destination)).toBe(true);
      await ending;

      vi.useRealTimers();
      rmMock.mockImplementation(actualRm);
      await relay.endRun("run-pending-end");
      expect(destination && existsSync(destination)).toBe(false);
    } finally {
      vi.useRealTimers();
      rmMock.mockImplementation(actualRm);
      if (destination) await actualRm(dirname(destination), { force: true, recursive: true });
    }
  });

  it("does not let cleanup after a failed acquisition exceed the claim total deadline", async () => {
    vi.useFakeTimers();
    const actualRm = relayFileLifecycle.actualRm;
    if (!actualRm) throw new Error("real rm fixture is unavailable");
    const cleanupStarted = deferred();
    rmMock.mockImplementation(async (path, options) => {
      if (String(path).includes("openmapx-operator-feed-relay-")) {
        cleanupStarted.resolve();
        return await new Promise<void>(() => {});
      }
      return actualRm(path, options);
    });
    const relay = new OperatorFeedRelayStore({
      maxEntries: 1,
      serveTotalMs: 100,
      download: async (options) => {
        writeFileSync(options.destination, "partial", { mode: 0o600 });
        throw new Error("remote acquisition rejected");
      },
    });
    const registration = relay.register({
      runId: "run-claim-cleanup-bound",
      sourceId: "operator:de:claim-cleanup-bound",
      remoteUrl: new URL("https://operator.example/claim-cleanup-bound.zip"),
    });

    try {
      let caught: Error | undefined;
      const consuming = relay
        .consume({ handle: registration.handle, runId: "run-claim-cleanup-bound" })
        .catch((error) => {
          caught = error as Error;
        });
      await cleanupStarted.promise;
      await vi.advanceTimersByTimeAsync(1_000);
      await consuming;
      expect(caught?.message).toBe("remote acquisition rejected");
      expect(() =>
        relay.register({
          runId: "run-blocked-claim-cleanup",
          sourceId: "operator:de:blocked-claim-cleanup",
          remoteUrl: new URL("https://operator.example/blocked-claim-cleanup.zip"),
        }),
      ).toThrow(/capacity/i);

      vi.useRealTimers();
      rmMock.mockImplementation(actualRm);
      await relay.endRun("run-claim-cleanup-bound");
    } finally {
      vi.useRealTimers();
      rmMock.mockImplementation(actualRm);
      await relay.endRun("run-claim-cleanup-bound").catch(() => {});
    }
  });

  it("enforces the claim total when an injected downloader ignores abort", async () => {
    vi.useFakeTimers();
    const actualRm = relayFileLifecycle.actualRm;
    if (!actualRm) throw new Error("real rm fixture is unavailable");
    const downloadStarted = deferred();
    const finishDownload = deferred();
    let workDirectory: string | undefined;
    rmMock.mockResolvedValue(undefined);
    const relay = new OperatorFeedRelayStore({
      maxEntries: 1,
      serveTotalMs: 100,
      download: async (options) => {
        workDirectory = dirname(options.destination);
        downloadStarted.resolve();
        await finishDownload.promise;
        throw new Error("late downloader failure");
      },
    });
    const registration = relay.register({
      runId: "run-ignored-abort",
      sourceId: "operator:de:ignored-abort",
      remoteUrl: new URL("https://operator.example/ignored-abort.zip"),
    });
    try {
      let outcome = "pending";
      const consuming = relay
        .consume({ handle: registration.handle, runId: "run-ignored-abort" })
        .then(
          () => {
            outcome = "resolved";
          },
          () => {
            outcome = "rejected";
          },
        );
      await downloadStarted.promise;
      await vi.advanceTimersByTimeAsync(1_000);

      expect(outcome).toBe("rejected");
      await consuming;
      expect(() =>
        relay.register({
          runId: "run-blocked-ignored-abort",
          sourceId: "operator:de:blocked-ignored-abort",
          remoteUrl: new URL("https://operator.example/blocked-ignored-abort.zip"),
        }),
      ).toThrow(/capacity/i);
      let endOutcome = "pending";
      const firstEnd = relay.endRun("run-ignored-abort").then(
        () => {
          endOutcome = "resolved";
        },
        () => {
          endOutcome = "rejected";
        },
      );
      await vi.advanceTimersByTimeAsync(10_000);
      expect(endOutcome).toBe("rejected");
      await firstEnd;

      vi.useRealTimers();
      finishDownload.resolve();
      await relay.endRun("run-ignored-abort");
    } finally {
      vi.useRealTimers();
      rmMock.mockImplementation(actualRm);
      if (workDirectory) await actualRm(workDirectory, { force: true, recursive: true });
    }
  });

  it("retains capacity when materialization outlives the claim and scavenges a late directory", async () => {
    vi.useFakeTimers();
    const actualMkdtemp = relayFileLifecycle.actualMkdtemp;
    const actualRm = relayFileLifecycle.actualRm;
    if (!actualMkdtemp || !actualRm) throw new Error("real filesystem fixtures are unavailable");
    const materialization = deferred();
    const lateDirectory = await actualMkdtemp(
      join(tmpdir(), "openmapx-operator-feed-relay-late-fixture-"),
    );
    mkdtempMock.mockImplementation(async () => {
      await materialization.promise;
      return lateDirectory;
    });
    const relay = new OperatorFeedRelayStore({ maxEntries: 1, serveTotalMs: 100 });
    const registration = relay.register({
      runId: "run-late-materialization",
      sourceId: "operator:de:late-materialization",
      remoteUrl: new URL("https://operator.example/late-materialization.zip"),
    });
    let outcome = "pending";
    const consuming = relay
      .consume({ handle: registration.handle, runId: "run-late-materialization" })
      .then(
        () => {
          outcome = "resolved";
        },
        () => {
          outcome = "rejected";
        },
      );

    try {
      await vi.advanceTimersByTimeAsync(1_000);
      expect(outcome).toBe("rejected");
      expect(() =>
        relay.register({
          runId: "run-blocked-late-materialization",
          sourceId: "operator:de:blocked-late-materialization",
          remoteUrl: new URL("https://operator.example/blocked-late-materialization.zip"),
        }),
      ).toThrow(/capacity/i);

      vi.useRealTimers();
      materialization.resolve();
      await consuming;
      await vi.waitFor(() => {
        expect(existsSync(lateDirectory)).toBe(false);
      });
      const replacement = relay.register({
        runId: "run-after-late-materialization",
        sourceId: "operator:de:after-late-materialization",
        remoteUrl: new URL("https://operator.example/after-late-materialization.zip"),
      });
      expect(replacement.handle).toMatch(/^[a-f0-9]{64}$/);
      await relay.endRun("run-after-late-materialization");
    } finally {
      vi.useRealTimers();
      mkdtempMock.mockImplementation(actualMkdtemp);
      await actualRm(lateDirectory, { force: true, recursive: true });
    }
  });

  it("applies one total deadline across acquisition and serving", async () => {
    const callerAbort = new AbortController();
    let acquisitionSignal: AbortSignal | undefined;
    const relay = new OperatorFeedRelayStore({
      maxEntries: 1,
      serveTotalMs: 20,
      serveIdleMs: 1_000,
      download: async (options) => {
        acquisitionSignal = options.signal;
        return await new Promise((_, reject) => {
          options.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
            once: true,
          });
        });
      },
    });
    const registration = relay.register({
      runId: "run-total-deadline",
      sourceId: "operator:de:total-deadline",
      remoteUrl: new URL("https://operator.example/total-deadline.zip"),
    });

    try {
      await expect(
        relay.consume({
          handle: registration.handle,
          runId: "run-total-deadline",
          signal: callerAbort.signal,
        }),
      ).rejects.toThrow(/deadline|timeout/i);
      expect(acquisitionSignal?.aborted).toBe(true);
      expect(() =>
        relay.register({
          runId: "run-after-total-deadline",
          sourceId: "operator:de:after-total-deadline",
          remoteUrl: new URL("https://operator.example/after-total-deadline.zip"),
        }),
      ).not.toThrow();
    } finally {
      callerAbort.abort(new Error("test cleanup"));
      await relay.endRun("run-total-deadline");
      await relay.endRun("run-after-total-deadline");
    }
  });

  it("settles an unread claimed payload after its idle deadline", async () => {
    let destination: string | undefined;
    const relay = new OperatorFeedRelayStore({
      maxEntries: 1,
      serveTotalMs: 1_000,
      serveIdleMs: 20,
      download: async (options) => {
        destination = options.destination;
        return successfulDownload(Buffer.alloc(256 * 1024, "x").toString())(options);
      },
    });
    const registration = relay.register({
      runId: "run-unread",
      sourceId: "operator:de:unread",
      remoteUrl: new URL("https://operator.example/unread.zip"),
    });
    const payload = await relay.consume({ handle: registration.handle, runId: "run-unread" });
    payload.stream.on("error", () => {});

    await waitForClose(payload.stream);
    expect(payload.stream.destroyed).toBe(true);
    await vi.waitFor(() => {
      expect(destination && existsSync(destination)).toBe(false);
    });
    const replacement = relay.register({
      runId: "run-after-unread",
      sourceId: "operator:de:after-unread",
      remoteUrl: new URL("https://operator.example/after-unread.zip"),
    });
    expect(replacement.handle).toMatch(/^[a-f0-9]{64}$/);
    await relay.endRun("run-after-unread");
  });

  it("keeps the total deadline active after a small payload is fully buffered", async () => {
    let destination: string | undefined;
    const relay = new OperatorFeedRelayStore({
      maxEntries: 1,
      serveTotalMs: 20,
      serveIdleMs: 1_000,
      download: async (options) => {
        destination = options.destination;
        return successfulDownload("small archive")(options);
      },
    });
    const registration = relay.register({
      runId: "run-buffered-total",
      sourceId: "operator:de:buffered-total",
      remoteUrl: new URL("https://operator.example/buffered-total.zip"),
    });
    const payload = await relay.consume({
      handle: registration.handle,
      runId: "run-buffered-total",
    });
    payload.stream.on("error", () => {});

    const outcome = await Promise.race([
      waitForClose(payload.stream).then(() => "closed" as const),
      new Promise<"still-open">((resolve) => setTimeout(() => resolve("still-open"), 100)),
    ]);
    expect(outcome).toBe("closed");
    await vi.waitFor(() => {
      expect(destination && existsSync(destination)).toBe(false);
    });
    const replacement = relay.register({
      runId: "run-after-buffered-total",
      sourceId: "operator:de:after-buffered-total",
      remoteUrl: new URL("https://operator.example/after-buffered-total.zip"),
    });
    expect(replacement.handle).toMatch(/^[a-f0-9]{64}$/);
    await relay.endRun("run-after-buffered-total");
  });

  it("keeps a fully buffered tail alive while downstream reads one byte every 10ms", async () => {
    vi.useFakeTimers();
    const relay = new OperatorFeedRelayStore({
      maxEntries: 1,
      serveTotalMs: 1_000,
      serveIdleMs: 15,
      download: successfulDownload(Buffer.alloc(64, "x").toString()),
    });
    const registration = relay.register({
      runId: "run-slow-buffered-reader",
      sourceId: "operator:de:slow-buffered-reader",
      remoteUrl: new URL("https://operator.example/slow-buffered-reader.zip"),
    });
    const payload = await relay.consume({
      handle: registration.handle,
      runId: "run-slow-buffered-reader",
    });
    payload.stream.on("error", () => {});
    if (payload.stream.readableLength === 0) {
      await new Promise<void>((resolve) => payload.stream.once("readable", resolve));
    }

    try {
      let downstreamBytes = 0;
      for (let index = 0; index < 64; index += 1) {
        await vi.advanceTimersByTimeAsync(10);
        const byte = payload.stream.read(1) as Buffer | null;
        expect(byte).not.toBeNull();
        downstreamBytes += byte?.length ?? 0;
      }
      expect(downstreamBytes).toBe(64);
      expect(payload.stream.destroyed).toBe(false);
    } finally {
      vi.useRealTimers();
      await payload.release().catch(() => {});
    }
  });

  it("expires a fully buffered tail after downstream consumption stalls", async () => {
    vi.useFakeTimers();
    const relay = new OperatorFeedRelayStore({
      maxEntries: 1,
      serveTotalMs: 1_000,
      serveIdleMs: 15,
      download: successfulDownload(Buffer.alloc(64, "x").toString()),
    });
    const registration = relay.register({
      runId: "run-stalled-buffered-reader",
      sourceId: "operator:de:stalled-buffered-reader",
      remoteUrl: new URL("https://operator.example/stalled-buffered-reader.zip"),
    });
    const payload = await relay.consume({
      handle: registration.handle,
      runId: "run-stalled-buffered-reader",
    });
    payload.stream.on("error", () => {});
    if (payload.stream.readableLength === 0) {
      await new Promise<void>((resolve) => payload.stream.once("readable", resolve));
    }
    expect((payload.stream.read(1) as Buffer | null)?.length).toBe(1);
    const closed = waitForClose(payload.stream);

    await vi.advanceTimersByTimeAsync(16);
    await closed;
    expect(payload.stream.destroyed).toBe(true);
    vi.useRealTimers();
    await payload.release().catch(() => {});
  });

  it("enforces the total deadline even while buffered downstream progress resets idle", async () => {
    vi.useFakeTimers();
    const relay = new OperatorFeedRelayStore({
      maxEntries: 1,
      serveTotalMs: 45,
      serveIdleMs: 15,
      download: successfulDownload(Buffer.alloc(64, "x").toString()),
    });
    const registration = relay.register({
      runId: "run-progress-total",
      sourceId: "operator:de:progress-total",
      remoteUrl: new URL("https://operator.example/progress-total.zip"),
    });
    const payload = await relay.consume({
      handle: registration.handle,
      runId: "run-progress-total",
    });
    payload.stream.on("error", () => {});
    if (payload.stream.readableLength === 0) {
      await new Promise<void>((resolve) => payload.stream.once("readable", resolve));
    }
    for (let index = 0; index < 4; index += 1) {
      await vi.advanceTimersByTimeAsync(10);
      expect((payload.stream.read(1) as Buffer | null)?.length).toBe(1);
    }
    const closed = waitForClose(payload.stream);

    await vi.advanceTimersByTimeAsync(10);
    await closed;
    expect(payload.stream.destroyed).toBe(true);
    vi.useRealTimers();
    await payload.release().catch(() => {});
  });

  it("settles a partially consumed payload after its idle deadline", async () => {
    let destination: string | undefined;
    const relay = new OperatorFeedRelayStore({
      maxEntries: 1,
      serveTotalMs: 1_000,
      serveIdleMs: 20,
      download: async (options) => {
        destination = options.destination;
        return successfulDownload(Buffer.alloc(256 * 1024, "x").toString())(options);
      },
    });
    const registration = relay.register({
      runId: "run-partial-reader",
      sourceId: "operator:de:partial-reader",
      remoteUrl: new URL("https://operator.example/partial-reader.zip"),
    });
    const payload = await relay.consume({
      handle: registration.handle,
      runId: "run-partial-reader",
    });
    payload.stream.on("error", () => {});
    await new Promise<void>((resolve) => {
      payload.stream.once("data", () => {
        payload.stream.pause();
        resolve();
      });
    });

    await waitForClose(payload.stream);
    await vi.waitFor(() => {
      expect(destination && existsSync(destination)).toBe(false);
    });
    const replacement = relay.register({
      runId: "run-after-partial-reader",
      sourceId: "operator:de:after-partial-reader",
      remoteUrl: new URL("https://operator.example/after-partial-reader.zip"),
    });
    expect(replacement.handle).toMatch(/^[a-f0-9]{64}$/);
    await relay.endRun("run-after-partial-reader");
  });

  it("propagates a caller disconnect through a claimed response stream", async () => {
    let destination: string | undefined;
    const relay = new OperatorFeedRelayStore({
      maxEntries: 1,
      serveTotalMs: 1_000,
      serveIdleMs: 1_000,
      download: async (options) => {
        destination = options.destination;
        return successfulDownload(Buffer.alloc(256 * 1024, "x").toString())(options);
      },
    });
    const registration = relay.register({
      runId: "run-disconnect",
      sourceId: "operator:de:disconnect",
      remoteUrl: new URL("https://operator.example/disconnect.zip"),
    });
    const disconnect = new AbortController();
    const payload = await relay.consume({
      handle: registration.handle,
      runId: "run-disconnect",
      signal: disconnect.signal,
    });
    payload.stream.on("error", () => {});
    disconnect.abort(new Error("Relay client disconnected"));

    await waitForClose(payload.stream);
    await vi.waitFor(() => {
      expect(destination && existsSync(destination)).toBe(false);
    });
    const replacement = relay.register({
      runId: "run-after-disconnect",
      sourceId: "operator:de:after-disconnect",
      remoteUrl: new URL("https://operator.example/after-disconnect.zip"),
    });
    expect(replacement.handle).toMatch(/^[a-f0-9]{64}$/);
    await relay.endRun("run-after-disconnect");
  });

  it("destroys and settles a claimed response stream when its run ends", async () => {
    let destination: string | undefined;
    const relay = new OperatorFeedRelayStore({
      maxEntries: 1,
      serveTotalMs: 1_000,
      serveIdleMs: 1_000,
      download: async (options) => {
        destination = options.destination;
        return successfulDownload(Buffer.alloc(256 * 1024, "x").toString())(options);
      },
    });
    const registration = relay.register({
      runId: "run-ended-stream",
      sourceId: "operator:de:ended-stream",
      remoteUrl: new URL("https://operator.example/ended-stream.zip"),
    });
    const payload = await relay.consume({
      handle: registration.handle,
      runId: "run-ended-stream",
    });
    payload.stream.on("error", () => {});

    await relay.endRun("run-ended-stream");
    expect(payload.stream.destroyed).toBe(true);
    expect(destination && existsSync(destination)).toBe(false);
    await expect(payload.release()).resolves.toBeUndefined();
    const replacement = relay.register({
      runId: "run-after-ended-stream",
      sourceId: "operator:de:after-ended-stream",
      remoteUrl: new URL("https://operator.example/after-ended-stream.zip"),
    });
    expect(replacement.handle).toMatch(/^[a-f0-9]{64}$/);
    await relay.endRun("run-after-ended-stream");
  });

  it("audits only bounded metadata and never the URL or capability", async () => {
    const events: OperatorFeedRelayAuditEvent[] = [];
    const relay = new OperatorFeedRelayStore({
      download: successfulDownload("archive"),
      audit: (event) => events.push(event),
    });
    const registration = relay.register({
      runId: "run-a",
      sourceId: "operator:de:demo",
      remoteUrl: new URL("https://operator.example/private/feed.zip?fixture=secret"),
    });

    const payload = await relay.consume({ handle: registration.handle, runId: "run-a" });
    await payload.release();

    expect(events).toEqual([
      expect.objectContaining({
        sourceKind: "operator-gtfs",
        hostname: "operator.example",
        outcome: "ok",
        bytes: 7,
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ]);
    const auditJson = JSON.stringify(events);
    expect(auditJson).not.toContain("/private/feed.zip");
    expect(auditJson).not.toContain("fixture=secret");
    expect(auditJson).not.toContain(registration.handle);
  });
});
