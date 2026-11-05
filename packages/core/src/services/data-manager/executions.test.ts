import { describe, expect, it } from "vitest";
import {
  dataExecutionInputSchema,
  dataExecutionStatusSchema,
  normalizeDataExecutionInput,
} from "./contracts/executions";
import {
  DataExecutionObservationPending,
  observeDataExecution,
  requestDataExecutionCancellation,
} from "./executions";
import { createDataManagerTransport } from "./transport";

describe("durable data execution receipts", () => {
  it("normalizes country identity and rejects arbitrary effects", () => {
    expect(
      normalizeDataExecutionInput({ kind: "transit-sync", countries: ["DE", "ch", "de"] }),
    ).toEqual({ kind: "transit-sync", countries: ["ch", "de"] });
    expect(
      dataExecutionInputSchema.safeParse({ kind: "download-osm", region: "../private" }).success,
    ).toBe(false);
    expect(
      dataExecutionInputSchema.safeParse({ kind: "download-fonts", url: "https://example.test" })
        .success,
    ).toBe(false);
    expect(
      dataExecutionInputSchema.safeParse({
        kind: "overture-pull",
        region: "europe/germany",
        restart: true,
      }).success,
    ).toBe(false);
  });
  it("rejects foreign results and private metadata in a public status", () => {
    const status = {
      id: "00000000-0000-4000-8000-000000000001",
      operationKey: "opk1_abcdefghijklmnop",
      fingerprint: "a".repeat(64),
      admittedAt: 1000,
      deadlineAt: 2000,
      kind: "download-fonts",
      status: "ok",
      cancellationRequestedAt: null,
      progress: 1,
      diagnostics: { tail: [], truncated: false },
      publication: "committed",
      result: { kind: "download-fonts", completed: true },
    };
    expect(dataExecutionStatusSchema.safeParse(status).success).toBe(true);
    expect(
      dataExecutionStatusSchema.safeParse({
        ...status,
        result: { kind: "download-osm", region: "de", sizeBytes: 1 },
      }).success,
    ).toBe(false);
    expect(dataExecutionStatusSchema.safeParse({ ...status, children: [] }).success).toBe(false);
    expect(
      dataExecutionStatusSchema.safeParse({
        ...status,
        result: { kind: "download-fonts", completed: true, path: "/host" },
      }).success,
    ).toBe(false);
  });
});

it("retires a disconnected observer without sending backend cancellation", async () => {
  const controller = new AbortController();
  const identity = {
    id: "00000000-0000-4000-8000-000000000001",
    operationKey: "opk1_abcdefghijklmnop",
    fingerprint: "a".repeat(64),
  };
  const methods: string[] = [];
  const transport = createDataManagerTransport({
    baseUrl: "http://127.0.0.1",
    fetch: async (_url, options) => {
      methods.push(options?.method ?? "GET");
      return Response.json({
        ...identity,
        admittedAt: 1000,
        deadlineAt: 2000,
        kind: "download-fonts",
        status: "running",
        cancellationRequestedAt: null,
        progress: 0.2,
        diagnostics: { tail: [], truncated: false },
        publication: "not_started",
      });
    },
  });
  await expect(
    observeDataExecution(identity, {
      transport,
      signal: controller.signal,
      observerDeadlineAt: Date.now() + 10000,
      onProgress: () => controller.abort(),
    }),
  ).rejects.toMatchObject({
    name: "DataExecutionObservationPending",
    reason: "interrupted",
    identity,
  });
  expect(methods).toEqual(["GET"]);
});
it("uses an independent explicit fingerprint-bound cancellation request", async () => {
  const identity = {
    id: "00000000-0000-4000-8000-000000000001",
    operationKey: "opk1_abcdefghijklmnop",
    fingerprint: "a".repeat(64),
  };
  const requests: Array<{ method: string; body: string }> = [];
  const transport = createDataManagerTransport({
    baseUrl: "http://127.0.0.1",
    fetch: async (_url, options) => {
      requests.push({ method: options?.method ?? "GET", body: String(options?.body ?? "") });
      return Response.json({
        ...identity,
        admittedAt: 1000,
        deadlineAt: 2000,
        kind: "download-fonts",
        status: "cancel_pending",
        cancellationRequestedAt: "2026-10-25T00:00:00.000Z",
        progress: 0.2,
        diagnostics: { tail: [], truncated: false },
        publication: "unknown",
      });
    },
  });
  expect((await requestDataExecutionCancellation(identity, { transport })).status).toBe(
    "cancel_pending",
  );
  expect(requests).toEqual([
    {
      method: "POST",
      body: JSON.stringify({
        operationKey: identity.operationKey,
        fingerprint: identity.fingerprint,
      }),
    },
  ]);
  expect(new DataExecutionObservationPending(identity, "transport").identity).toEqual(identity);
});
