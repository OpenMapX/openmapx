import { describe, expect, it, vi } from "vitest";
import type { ApiOpsClient } from "../../services/ops-client.js";
import {
  dockerComposeAction,
  dockerComposeLogSnapshot,
  dockerComposeLogs,
  dockerComposePs,
  dockerStatus,
  inspectDawarichProvisioning,
} from "../docker-compose.js";

function clientWithExecute(execute: ApiOpsClient["execute"]): ApiOpsClient {
  return {
    execute,
    status: vi.fn(),
    events: vi.fn(),
    cancel: vi.fn(),
    lookup: vi.fn(),
  };
}

describe("inspectDawarichProvisioning", () => {
  it("returns the strict provisioning inspection result", async () => {
    const execute = vi.fn(async () => ({
      execution: "sync" as const,
      kind: "dawarich.provisioning.inspect" as const,
      value: {
        services: [
          { serviceId: "dawarich-app" as const, state: "running" as const },
          { serviceId: "dawarich-sidekiq" as const, state: "running" as const },
          { serviceId: "dawarich-postgis" as const, state: "running" as const },
          { serviceId: "dawarich-redis" as const, state: "running" as const },
        ],
        appliedGenerations: {
          app: "0123456789abcdef0123456789abcdef",
          worker: null,
        },
      },
    })) as ApiOpsClient["execute"];
    await expect(
      inspectDawarichProvisioning({ client: clientWithExecute(execute) }),
    ).resolves.toMatchObject({
      appliedGenerations: { app: "0123456789abcdef0123456789abcdef", worker: null },
    });
    expect(execute).toHaveBeenCalledWith({ kind: "dawarich.provisioning.inspect" }, {});
  });
});

describe("typed Compose facade", () => {
  it("does not report a stopped stack when control-plane acquisition fails", async () => {
    const execute = vi.fn().mockRejectedValue(new Error("Agent unavailable"));
    await expect(dockerComposePs({ client: clientWithExecute(execute) })).rejects.toThrow();
  });
  it("preserves an unfamiliar observed state as unknown", async () => {
    const execute = vi.fn().mockResolvedValue({
      execution: "sync",
      value: { services: [{ serviceId: "motis", state: "unknown" }] },
    });
    await expect(dockerComposePs({ client: clientWithExecute(execute) })).resolves.toEqual([
      { service: "motis", state: "unknown" },
    ]);
  });

  it("does not submit follow work for an already disconnected response", async () => {
    const execute = vi.fn() as ApiOpsClient["execute"];
    const out = Object.assign(new EventEmitter(), {
      destroyed: true,
      writableEnded: false,
      write: vi.fn(),
      end: vi.fn(),
    });
    await dockerComposeLogs("redis", out as never, {
      client: clientWithExecute(execute),
      tail: 20,
      operationKey: "opk1_followDisconnected0",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("recovers the same admitted follow key after a disconnect and cancels the retained job", async () => {
    const operationKey = "opk1_followAmbiguous000";
    const out = Object.assign(new EventEmitter(), {
      destroyed: false,
      writableEnded: false,
      write: vi.fn(),
      end: vi.fn(),
    });
    const execute = vi
      .fn()
      .mockImplementationOnce(async (_operation, options: { signal?: AbortSignal }) => {
        out.destroyed = true;
        out.emit("close");
        throw options.signal?.reason ?? new DOMException("Aborted", "AbortError");
      });
    const lookup = vi.fn().mockResolvedValue({
      version: 1,
      operationId: "job1_followAmbiguous000",
      operationKey,
      kind: "service.logs.follow",
      resourceId: "redis",
      state: "running",
      submittedAt: "2026-08-23T10:00:00.000Z",
      updatedAt: "2026-08-23T10:00:01.000Z",
    });
    const cancel = vi.fn().mockResolvedValue({
      version: 1,
      operationId: "job1_followAmbiguous000",
      operationKey,
      kind: "service.logs.follow",
      resourceId: "redis",
      state: "termination_pending",
      submittedAt: "2026-08-23T10:00:00.000Z",
      updatedAt: "2026-08-23T10:00:01.000Z",
    });
    const client = { ...clientWithExecute(execute), lookup, cancel };

    await dockerComposeLogs("redis", out as never, { client, tail: 20, operationKey });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[1]).toMatchObject({ operationKey });
    expect(lookup).toHaveBeenCalledWith(
      {
        kind: "service.logs.follow",
        serviceId: "redis",
        tail: 20,
        maxDurationSeconds: 900,
      },
      operationKey,
      expect.anything(),
    );
    expect(cancel).toHaveBeenCalledWith("job1_followAmbiguous000", expect.anything());
    expect(client.events).not.toHaveBeenCalled();
  });

  it("surfaces a fixed failure when terminal follow events end in failed status", async () => {
    const operationKey = "opk1_followTerminalFail00";
    const out = Object.assign(new EventEmitter(), {
      destroyed: false,
      writableEnded: false,
      write: vi.fn(),
      end: vi.fn(),
    });
    const client = clientWithExecute(
      vi.fn().mockResolvedValue({
        execution: "async",
        operationId: "job1_followTerminalFail00",
        operationKey,
        kind: "service.logs.follow",
        state: "running",
      }) as ApiOpsClient["execute"],
    );
    vi.mocked(client.events).mockResolvedValue({
      version: 1,
      operationId: "job1_followTerminalFail00",
      nextCursor: 1,
      terminal: true,
      truncated: true,
      events: [{ cursor: 1, type: "log", stream: "stdout", message: "truncated" }],
    });
    vi.mocked(client.status).mockResolvedValue({
      version: 1,
      operationId: "job1_followTerminalFail00",
      operationKey,
      kind: "service.logs.follow",
      resourceId: "redis",
      state: "failed",
      errorClass: "runtime",
      submittedAt: "2026-08-23T10:00:00.000Z",
      updatedAt: "2026-08-23T10:00:01.000Z",
    });

    await dockerComposeLogs("redis", out as never, { client, tail: 20, operationKey });
    expect(out.write).toHaveBeenLastCalledWith("Operations log stream ended.\n");
    expect(client.cancel).not.toHaveBeenCalled();
  });

  it("maps status and bounded snapshots to exact typed operations", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({
        execution: "sync",
        kind: "stack.status",
        value: { services: [{ serviceId: "redis", state: "running" }] },
      })
      .mockResolvedValueOnce({
        execution: "sync",
        kind: "service.logs",
        value: { lines: ["one", "two"], truncated: false },
      }) as ApiOpsClient["execute"];
    const client = clientWithExecute(execute);

    await expect(dockerComposePs({ client })).resolves.toEqual([
      { service: "redis", state: "running" },
    ]);
    await expect(dockerComposeLogSnapshot("redis", 2, { client })).resolves.toEqual({
      lines: ["one", "two"],
      truncated: false,
    });
    expect(execute).toHaveBeenNthCalledWith(1, { kind: "stack.status" }, {});
    expect(execute).toHaveBeenNthCalledWith(
      2,
      { kind: "service.logs", serviceId: "redis", tail: 2 },
      {},
    );
  });

  it("maps Docker availability to the fixed status operation", async () => {
    const execute = vi.fn(async () => ({
      execution: "sync" as const,
      kind: "docker.status" as const,
      value: { reachable: true, version: "29.0.0" },
    })) as ApiOpsClient["execute"];
    await expect(dockerStatus({ client: clientWithExecute(execute) })).resolves.toEqual({
      reachable: true,
      version: "29.0.0",
    });
    expect(execute).toHaveBeenCalledWith({ kind: "docker.status" }, {});
  });

  it("never installs an injected test client as the production singleton", async () => {
    const execute = vi.fn(async () => ({
      execution: "sync" as const,
      kind: "stack.status" as const,
      value: { services: [] },
    })) as ApiOpsClient["execute"];
    await dockerComposePs({ client: clientWithExecute(execute) });
    const previousUrl = process.env.OPS_AGENT_URL;
    const previousTokenFile = process.env.OPS_AGENT_TOKEN_FILE;
    delete process.env.OPS_AGENT_URL;
    delete process.env.OPS_AGENT_TOKEN_FILE;
    try {
      await expect(dockerComposePs()).rejects.toThrow();
    } finally {
      if (previousUrl !== undefined) process.env.OPS_AGENT_URL = previousUrl;
      if (previousTokenFile !== undefined) process.env.OPS_AGENT_TOKEN_FILE = previousTokenFile;
    }
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it.each(["restart", "recreate", "recreate-isolated"] as const)(
    "requires original administrative authority for %s",
    async (action) => {
      const execute = vi.fn() as ApiOpsClient["execute"];
      const result = await dockerComposeAction("motis", action, {
        client: clientWithExecute(execute),
        operationKey: "opk1_abcdefghijklmnopqrstuvwxyzABCDEFGH123456789",
        expectedConfigurationRevisionId: `cfg1_${"a".repeat(43)}`,
      });
      expect(result).toMatchObject({
        exitCode: 1,
        stderr: "Operations request failed (control_upgrade_required).",
      });
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it("refuses stack.stop locally with fixed operator recovery guidance", async () => {
    const execute = vi.fn() as ApiOpsClient["execute"];
    const result = await dockerComposeAction("", "stop", {
      client: clientWithExecute(execute),
      operationKey: "opk1_abcdefghijklmnopqrstuvwxyzABCDEFGH123456789",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      "Stack shutdown is unavailable from the web API because it would stop the operations agent. Run the documented host shutdown command instead.",
    );
    expect(execute).not.toHaveBeenCalled();
  });
});

import { EventEmitter } from "node:events";

it("uses only the synchronous typed snapshot for follow:false", async () => {
  const out = Object.assign(new EventEmitter(), {
    destroyed: false,
    writableEnded: false,
    write: vi.fn(),
    end: vi.fn(),
  });
  const execute = vi.fn().mockResolvedValue({
    execution: "sync",
    kind: "service.logs",
    value: { lines: ["one", "two"], truncated: true },
  }) as ApiOpsClient["execute"];
  const api = clientWithExecute(execute);
  await dockerComposeLogs("app-api", out as never, {
    client: api,
    tail: 200,
    follow: false,
    operationKey: "opk1_snapshotOnly000000",
  });
  expect(execute).toHaveBeenCalledWith(
    { kind: "service.logs", serviceId: "app-api", tail: 200 },
    { signal: expect.any(AbortSignal) },
  );
  expect(api.events).not.toHaveBeenCalled();
  expect(api.cancel).not.toHaveBeenCalled();
  expect(out.write).toHaveBeenCalledWith("Log snapshot truncated.\n");
  expect(out.end).toHaveBeenCalledOnce();
});
it("cancels only its admitted log reader when the active HTTP observer closes", async () => {
  const out = Object.assign(new EventEmitter(), {
    destroyed: false,
    writableEnded: false,
    write: vi.fn(),
    end: vi.fn(),
  });
  const execute = vi.fn().mockResolvedValue({
    execution: "async",
    kind: "service.logs.follow",
    operationId: "job1_ownedLogReader0000",
    operationKey: "opk1_ownedLogReader0000",
    state: "running",
  }) as ApiOpsClient["execute"];
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const api = clientWithExecute(execute);
  api.cancel = vi.fn().mockResolvedValue({});
  api.events = vi.fn(async (_id, options) => {
    entered();
    return new Promise((_resolve, reject) =>
      options?.signal?.addEventListener(
        "abort",
        () => reject(new DOMException("Aborted", "AbortError")),
        { once: true },
      ),
    );
  }) as ApiOpsClient["events"];
  const observing = dockerComposeLogs("redis", out as never, {
    client: api,
    tail: 100,
    maxDurationSeconds: 30,
    operationKey: "opk1_ownedLogReader0000",
  });
  await ready;
  out.destroyed = true;
  out.emit("close");
  await observing;
  expect(api.cancel).toHaveBeenCalledOnce();
  expect(api.cancel).toHaveBeenCalledWith("job1_ownedLogReader0000", {
    signal: expect.any(AbortSignal),
  });
  expect(execute).toHaveBeenCalledOnce();
});
