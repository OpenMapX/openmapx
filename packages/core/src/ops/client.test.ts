import { execFileSync } from "node:child_process";
import { linkSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpsClient, OpsClientError, opsRequestTimeoutMs, readOpsTokenFile } from "./client";
import { OPS_MAX_HTTP_RESPONSE_BYTES } from "./contract";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tokenFile(contents = Buffer.alloc(32, 7).toString("base64url")): string {
  const root = mkdtempSync(join(tmpdir(), "openmapx-ops-token-"));
  roots.push(root);
  const path = join(root, "token");
  writeFileSync(path, contents);
  return path;
}

describe("ops client", () => {
  it("derives synchronous transport timeouts from the per-kind execution budget", () => {
    expect(opsRequestTimeoutMs("docker.status")).toBe(10_000);
    expect(opsRequestTimeoutMs("service.logs")).toBe(35_000);
    expect(opsRequestTimeoutMs("service.logs", 7)).toBe(7);
    expect(opsRequestTimeoutMs("service.pull")).toBe(15_000);
  });
  it("reads exactly one bounded canonical file token", async () => {
    const token = Buffer.alloc(32, 3).toString("base64url");
    await expect(readOpsTokenFile(tokenFile(token))).resolves.toBe(token);
    for (const invalid of [`${token}\n`, token.slice(1), "x".repeat(1_000_000)]) {
      await expect(readOpsTokenFile(tokenFile(invalid))).rejects.toThrow(
        "Ops agent credential is unavailable",
      );
    }
  });

  it("sends a versioned, expiring envelope with the token only in Authorization", async () => {
    const token = Buffer.alloc(32, 9).toString("base64url");
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({
        version: 1,
        requestId: "ops1_AQEBAQEBAQEBAQEBAQEBAQEB",
        operationKey: "opk1_AQEBAQEBAQEBAQEBAQEBAQEB",
        issuedAt: "2026-08-23T18:00:00.000Z",
        expiresAt: "2026-08-23T18:00:20.000Z",
        operation: { kind: "docker.status" },
      });
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${token}`);
      expect(String(init?.body)).not.toContain(token);
      return new Response(
        JSON.stringify({
          version: 1,
          requestId: body.requestId,
          ok: true,
          result: {
            execution: "sync",
            kind: "docker.status",
            value: { reachable: true, version: "29.0.0" },
          },
        }),
        { status: 200 },
      );
    });
    const client = new OpsClient({
      baseUrl: "http://ops-agent:4300",
      tokenFile: tokenFile(token),
      fetch,
      now: () => new Date("2026-08-23T18:00:00.000Z"),
      randomBytes: () => Buffer.alloc(18, 1),
    });

    await expect(client.execute({ kind: "docker.status" })).resolves.toEqual({
      execution: "sync",
      kind: "docker.status",
      value: { reachable: true, version: "29.0.0" },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("bounds response bodies and never includes token, file path, URL, or remote body in errors", async () => {
    const token = Buffer.alloc(32, 11).toString("base64url");
    const path = tokenFile(token);
    const secretBody = `remote docker stderr ${token}`;
    const client = new OpsClient({
      baseUrl: "http://ops-agent:4300",
      tokenFile: path,
      maxResponseBytes: 32,
      fetch: async () => new Response(secretBody, { status: 500 }),
    });

    const error = await client.execute({ kind: "docker.status" }).catch((cause) => cause);
    expect(error).toBeInstanceOf(OpsClientError);
    expect(String(error)).toBe("OpsClientError: Ops agent request failed");
    for (const secret of [token, path, "ops-agent:4300", secretBody]) {
      expect(String(error)).not.toContain(secret);
    }
  });

  it("aborts a request at the configured time limit", async () => {
    const fetch = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );
    const client = new OpsClient({
      baseUrl: "http://ops-agent:4300",
      tokenFile: tokenFile(),
      fetch,
      requestTimeoutMs: 5,
    });
    await expect(client.execute({ kind: "docker.status" })).rejects.toMatchObject({
      name: "OpsClientError",
      errorClass: "timeout",
    });
  });

  it("rejects non-private destinations without echoing the URL", () => {
    for (const baseUrl of ["http://evil.example/steal?token=x", "https://evil.example"]) {
      expect(() => new OpsClient({ baseUrl, tokenFile: tokenFile() })).toThrow(
        "Invalid ops agent destination",
      );
    }
  });

  it("opens token files no-follow/nonblocking and rejects links and special files without hanging", async () => {
    const token = Buffer.alloc(32, 13).toString("base64url");
    const root = mkdtempSync(join(tmpdir(), "openmapx-ops-token-special-"));
    roots.push(root);
    const target = join(root, "target");
    writeFileSync(target, token);
    const symlink = join(root, "symlink");
    symlinkSync(target, symlink);
    const hardlink = join(root, "hardlink");
    linkSync(target, hardlink);
    const fifo = join(root, "fifo");
    execFileSync("mkfifo", [fifo]);

    for (const path of [symlink, hardlink, fifo, "/dev/null"]) {
      await expect(
        Promise.race([
          readOpsTokenFile(path),
          new Promise((_resolve, reject) => setTimeout(() => reject(new Error("hung")), 250)),
        ]),
      ).rejects.toThrow("Ops agent credential is unavailable");
    }
  });

  it("caps timeout/body options and rejects a result that does not match the requested kind", async () => {
    for (const options of [
      { requestTimeoutMs: 0 },
      { requestTimeoutMs: 30 * 60_000 + 1 },
      { maxResponseBytes: 0 },
      { maxResponseBytes: OPS_MAX_HTTP_RESPONSE_BYTES + 1 },
      { maxResponseBytes: Number.POSITIVE_INFINITY },
    ]) {
      expect(
        () =>
          new OpsClient({
            baseUrl: "http://ops-agent:4300",
            tokenFile: tokenFile(),
            ...options,
          }),
      ).toThrow("Invalid ops client limits");
    }
    expect(
      () =>
        new OpsClient({
          baseUrl: "http://ops-agent:4300",
          tokenFile: tokenFile(),
          maxResponseBytes: OPS_MAX_HTTP_RESPONSE_BYTES,
        }),
    ).not.toThrow();
    const client = new OpsClient({
      baseUrl: "http://ops-agent:4300",
      tokenFile: tokenFile(),
      randomBytes: () => Buffer.alloc(18, 4),
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as { requestId: string };
        return new Response(
          JSON.stringify({
            version: 1,
            requestId: body.requestId,
            ok: true,
            result: { execution: "sync", kind: "docker.status", value: { changed: true } },
          }),
        );
      },
    });
    await expect(client.execute({ kind: "docker.status" })).rejects.toMatchObject({
      errorClass: "runtime",
    });
  });

  it("requires an observable reusable operation key before an async request is sent", async () => {
    const requests: Array<{ operationKey: string; requestId: string }> = [];
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        operationKey: string;
        requestId: string;
      };
      requests.push(body);
      return new Response(
        JSON.stringify({
          version: 1,
          requestId: body.requestId,
          ok: true,
          result: {
            execution: "async",
            operationId: "job1_reusableOperation1",
            operationKey: body.operationKey,
            kind: "service.pull",
            state: "running",
          },
        }),
        { status: 202 },
      );
    });
    const client = new OpsClient({
      baseUrl: "http://ops-agent:4300",
      tokenFile: tokenFile(),
      randomBytes: () => Buffer.alloc(18, 8),
      fetch,
    });

    await expect(client.execute({ kind: "service.pull", serviceId: "redis" })).rejects.toThrow(
      "Async operation key is required",
    );
    expect(fetch).not.toHaveBeenCalled();

    const operationKey = client.createOperationKey();
    await client.execute({ kind: "service.pull", serviceId: "redis" }, { operationKey });
    await client.execute({ kind: "service.pull", serviceId: "redis" }, { operationKey });
    expect(requests.map((request) => request.operationKey)).toEqual([operationKey, operationKey]);
  });

  it("sends owner-authenticated cancellation and validates the exact operation identity", async () => {
    const operationId = "job1_cancelOperation000";
    const token = Buffer.alloc(32, 17).toString("base64url");
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe(`http://ops-agent:4300/v1/operations/${operationId}`);
      expect(init?.method).toBe("DELETE");
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${token}`);
      const requestId = new Headers(init?.headers).get("x-ops-request-id");
      return new Response(
        JSON.stringify({
          version: 1,
          requestId,
          ok: true,
          result: {
            version: 1,
            operationId,
            operationKey: "opk1_cancelOperation000",
            kind: "service.logs.follow",
            resourceId: "redis",
            state: "termination_pending",
            submittedAt: "2026-08-23T18:00:00.000Z",
            updatedAt: "2026-08-23T18:00:01.000Z",
          },
        }),
      );
    });
    const client = new OpsClient({
      baseUrl: "http://ops-agent:4300",
      tokenFile: tokenFile(token),
      fetch,
      randomBytes: () => Buffer.alloc(18, 6),
    });
    await expect(client.cancel(operationId)).resolves.toMatchObject({
      operationId,
      state: "termination_pending",
    });
  });

  it("looks up an owner-bound admission by the exact reusable operation key", async () => {
    const operationKey = "opk1_lookupOperation0000";
    const operationId = "job1_lookupOperation0000";
    const operation = {
      kind: "service.logs.follow",
      serviceId: "redis",
      tail: 20,
      maxDurationSeconds: 900,
    } as const;
    const fingerprints: string[] = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe(`http://ops-agent:4300/v1/operation-keys/${operationKey}`);
      const fingerprint = new Headers(init?.headers).get("x-ops-operation-fingerprint");
      expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
      fingerprints.push(fingerprint as string);
      const requestId = new Headers(init?.headers).get("x-ops-request-id");
      return new Response(
        JSON.stringify({
          version: 1,
          requestId,
          ok: true,
          result: {
            version: 1,
            operationId,
            operationKey,
            kind: "service.logs.follow",
            resourceId: "redis",
            state: "running",
            submittedAt: "2026-08-23T18:00:00.000Z",
            updatedAt: "2026-08-23T18:00:01.000Z",
          },
        }),
      );
    });
    const client = new OpsClient({
      baseUrl: "http://ops-agent:4300",
      tokenFile: tokenFile(),
      fetch,
      randomBytes: () => Buffer.alloc(18, 8),
    });
    await expect(client.lookup(operation, operationKey)).resolves.toMatchObject({
      operationId,
      operationKey,
      kind: "service.logs.follow",
      state: "running",
    });
    await client.lookup({ ...operation, tail: 21 }, operationKey);
    expect(fingerprints[0]).not.toBe(fingerprints[1]);
  });

  it("preserves caller AbortError for an in-flight event request", async () => {
    const controller = new AbortController();
    const client = new OpsClient({
      baseUrl: "http://ops-agent:4300",
      tokenFile: tokenFile(),
      requestTimeoutMs: 500,
      fetch: async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          if (init?.signal?.aborted) {
            reject(init.signal.reason);
            return;
          }
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    });
    const pending = client.events("job1_abortEvents00000", { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("carries caller AbortSignal through admission and retained status requests", async () => {
    const signals: AbortSignal[] = [];
    const client = new OpsClient({
      baseUrl: "http://ops-agent:4300",
      tokenFile: tokenFile(),
      requestTimeoutMs: 500,
      fetch: async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          if (!init?.signal) throw new Error("missing signal");
          signals.push(init.signal);
          init.signal.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        }),
    });
    const admissionAbort = new AbortController();
    const admission = client.execute(
      { kind: "service.pull", serviceId: "redis" },
      { operationKey: "opk1_signalAdmission000", signal: admissionAbort.signal },
    );
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    admissionAbort.abort();
    await expect(admission).rejects.toMatchObject({ name: "AbortError" });

    const statusAbort = new AbortController();
    const status = client.status("service.pull", "job1_signalStatus0000", {
      signal: statusAbort.signal,
    });
    await vi.waitFor(() => expect(signals).toHaveLength(2));
    statusAbort.abort();
    await expect(status).rejects.toMatchObject({ name: "AbortError" });
  });

  it("parses every retained async admission state without coercion", async () => {
    const states = [
      "queued",
      "running",
      "termination_pending",
      "succeeded",
      "failed",
      "timed_out",
    ] as const;
    let index = 0;
    const client = new OpsClient({
      baseUrl: "http://ops-agent:4300",
      tokenFile: tokenFile(),
      randomBytes: () => Buffer.alloc(18, 12),
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as {
          requestId: string;
          operationKey: string;
        };
        return new Response(
          JSON.stringify({
            version: 1,
            requestId: body.requestId,
            ok: true,
            result: {
              execution: "async",
              operationId: `job1_retainedClient${index}00`,
              operationKey: body.operationKey,
              kind: "service.pull",
              state: states[index++],
            },
          }),
          { status: 202 },
        );
      },
    });
    for (const [stateIndex, state] of states.entries()) {
      await expect(
        client.execute(
          { kind: "service.pull", serviceId: "redis" },
          { operationKey: `opk1_retainedClient${stateIndex}00` },
        ),
      ).resolves.toMatchObject({ state });
    }
  });

  it("strictly parses typed retained status and bounded event pages", async () => {
    const client = new OpsClient({
      baseUrl: "http://ops-agent:4300",
      tokenFile: tokenFile(),
      randomBytes: () => Buffer.alloc(18, 9),
      fetch: async (input, init) => {
        const requestId = new Headers(init?.headers).get("x-ops-request-id");
        const url = String(input);
        const result = url.endsWith("/events?after=0&limit=10")
          ? {
              version: 1,
              operationId: "job1_retainedOperation0",
              nextCursor: 1,
              terminal: false,
              truncated: false,
              events: [{ cursor: 1, type: "state", state: "running" }],
            }
          : {
              version: 1,
              operationId: "job1_retainedOperation0",
              operationKey: "opk1_retainedOperation0",
              kind: "service.pull",
              resourceId: "redis",
              state: "succeeded",
              submittedAt: "2026-08-23T18:00:00.000Z",
              updatedAt: "2026-08-23T18:00:01.000Z",
              result: { changed: true },
            };
        return new Response(JSON.stringify({ version: 1, requestId, ok: true, result }));
      },
    });

    await expect(client.status("service.pull", "job1_retainedOperation0")).resolves.toMatchObject({
      kind: "service.pull",
      state: "succeeded",
      result: { changed: true },
    });
    await expect(
      client.events("job1_retainedOperation0", { after: 0, limit: 10 }),
    ).resolves.toMatchObject({
      nextCursor: 1,
      events: [{ type: "state", state: "running" }],
    });
    await expect(client.status("docker.status", "job1_retainedOperation0")).rejects.toMatchObject({
      errorClass: "runtime",
    });
  });

  it("rejects retained responses for another operation and incoherent event cursors", async () => {
    const client = new OpsClient({
      baseUrl: "http://ops-agent:4300",
      tokenFile: tokenFile(),
      randomBytes: () => Buffer.alloc(18, 10),
      fetch: async (input, init) => {
        const requestId = new Headers(init?.headers).get("x-ops-request-id");
        const result = String(input).includes("/events?")
          ? {
              version: 1,
              operationId: "job1_anotherOperation00",
              nextCursor: 4,
              terminal: false,
              truncated: false,
              events: [{ cursor: 3, type: "state", state: "running" }],
            }
          : {
              version: 1,
              operationId: "job1_anotherOperation00",
              operationKey: "opk1_retainedOperation0",
              kind: "service.pull",
              resourceId: "redis",
              state: "running",
              submittedAt: "2026-08-23T18:00:00.000Z",
              updatedAt: "2026-08-23T18:00:01.000Z",
            };
        return new Response(JSON.stringify({ version: 1, requestId, ok: true, result }));
      },
    });
    await expect(client.status("service.pull", "job1_retainedOperation0")).rejects.toMatchObject({
      errorClass: "runtime",
    });
    await expect(
      client.events("job1_retainedOperation0", { after: 2, limit: 10 }),
    ).rejects.toMatchObject({ errorClass: "runtime" });
  });
});
