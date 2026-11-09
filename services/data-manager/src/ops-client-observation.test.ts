import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPS_PUBLIC_ERROR_MESSAGES, OpsClient, opsOperationFingerprint } from "@openmapx/core/ops";
import { afterEach, describe, expect, it, vi } from "vitest";
import { observeRetainedHostOperation, resetOpsClient } from "./ops-client";

const operationKey = "opk1_observeOperation0000";
const operation = {
  kind: "service.logs.follow",
  serviceId: "redis",
  tail: 20,
  maxDurationSeconds: 900,
} as const;
const roots: string[] = [];
afterEach(() => {
  resetOpsClient();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function retained(admittedAt = Date.now() - 120_000) {
  return {
    operationKey,
    operation,
    fingerprint: opsOperationFingerprint(operation),
    admittedAt,
    state: "attempted",
  };
}
function agent(reply: (requestId: string) => Response | Promise<Response>) {
  const root = mkdtempSync(join(tmpdir(), "openmapx-observe-"));
  roots.push(root);
  const tokenFile = join(root, "token");
  writeFileSync(tokenFile, Buffer.alloc(32, 9).toString("base64url"));
  const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
    reply(String(new Headers(init?.headers).get("x-ops-request-id"))),
  );
  resetOpsClient(new OpsClient({ baseUrl: "http://ops-agent:4300", tokenFile, fetch }));
  return fetch;
}
const status =
  (state: string, extra: Record<string, unknown> = {}) =>
  (requestId: string) =>
    Response.json({
      version: 1,
      requestId,
      ok: true,
      result: {
        version: 1,
        operationId: "job1_observeOperation0000",
        operationKey,
        kind: operation.kind,
        resourceId: "redis",
        state,
        submittedAt: "2026-08-23T18:00:00.000Z",
        updatedAt: "2026-08-23T18:00:01.000Z",
        ...extra,
      },
    });
const refusal =
  (errorClass: keyof typeof OPS_PUBLIC_ERROR_MESSAGES, code: number) => (requestId: string) =>
    Response.json(
      {
        version: 1,
        requestId,
        ok: false,
        error: { class: errorClass, message: OPS_PUBLIC_ERROR_MESSAGES[errorClass] },
      },
      { status: code },
    );

describe("observeRetainedHostOperation", () => {
  it.each([
    ["queued", "active"],
    ["running", "active"],
    ["termination_pending", "active"],
  ])("reports a %s operation as active", async (state, expected) => {
    agent(status(state));
    await expect(observeRetainedHostOperation(operationKey, retained())).resolves.toBe(expected);
  });

  it.each(["failed", "timed_out"])("reports a %s operation as terminal", async (state) => {
    agent(status(state, { errorClass: "runtime" }));
    await expect(observeRetainedHostOperation(operationKey, retained())).resolves.toBe("terminal");
  });

  it("only reads: every request is a lookup by operation key", async () => {
    const fetch = agent(status("running"));
    await observeRetainedHostOperation(operationKey, retained());
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0]?.[0])).toBe(
      `http://ops-agent:4300/v1/operation-keys/${operationKey}`,
    );
    expect(fetch.mock.calls[0]?.[1]?.method ?? "GET").toBe("GET");
  });

  it("treats an unreachable agent or an unreadable answer as unknown", async () => {
    agent(() => {
      throw new TypeError("fetch failed");
    });
    await expect(observeRetainedHostOperation(operationKey, retained())).resolves.toBe("unknown");
    agent(() => new Response("not json", { status: 502 }));
    await expect(observeRetainedHostOperation(operationKey, retained())).resolves.toBe("unknown");
    agent(refusal("conflict", 409));
    await expect(observeRetainedHostOperation(operationKey, retained())).resolves.toBe("unknown");
  });

  it("treats a missing agent configuration as unknown", async () => {
    resetOpsClient();
    vi.stubEnv("OPS_AGENT_URL", "");
    await expect(observeRetainedHostOperation(operationKey, retained())).resolves.toBe("unknown");
    vi.unstubAllEnvs();
  });

  it("accepts an agent that never recorded the key only after the request could have been admitted", async () => {
    agent(refusal("not_found", 404));
    await expect(observeRetainedHostOperation(operationKey, retained(Date.now()))).resolves.toBe(
      "unknown",
    );
    await expect(
      observeRetainedHostOperation(operationKey, retained(Date.now() - 31_000)),
    ).resolves.toBe("terminal");
  });

  it("does not guess when the retained record is incomplete", async () => {
    const fetch = agent(status("failed", { errorClass: "runtime" }));
    for (const broken of [
      { ...retained(), operation: undefined },
      { ...retained(), operation: { kind: "not.an.operation" } },
      { ...retained(), fingerprint: undefined },
      { ...retained(), admittedAt: "yesterday" },
    ])
      await expect(observeRetainedHostOperation(operationKey, broken)).resolves.toBe("unknown");
    expect(fetch).not.toHaveBeenCalled();
  });
});
