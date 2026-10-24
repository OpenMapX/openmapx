import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDbMock, type DbMock } from "../../test/db.js";

const dbMock: DbMock = createDbMock();

vi.mock("../../db/index.js", () => ({ db: dbMock.db }));

vi.mock("../ops-client", () => ({
  createApiOpsClient: vi.fn(() => ({})),
  createDurableOpsKey: vi.fn(
    (namespace: string, identity: string) => `opk1_${namespace}:${identity}`,
  ),
  executeAndWait: vi.fn(),
}));

import { executeAndWait } from "../ops-client";

let integrations: typeof import("../agent-integrations.js");
beforeAll(async () => {
  integrations = await import("../agent-integrations.js");
}, 30_000);

const executeMock = vi.mocked(executeAndWait);

const PENDING = `itx1_${"a".repeat(24)}`;
const OTHER = `itx1_${"b".repeat(24)}`;
const ARTIFACT = "https://releases.example/intg-one.tar.gz";
const SHA = "c".repeat(64);

type Entry = {
  integrationId: string;
  extensionId?: string | null;
  status?: "ok" | "needs_reinstall";
  reason?: string | null;
  files?: Array<{ path: string; sha256: string }>;
  pending?: { transactionId: string } | null;
};

function snapshot(entries: Entry[], unrecorded: string[] = []) {
  return {
    integrations: entries.map((entry) => ({
      extensionId: null,
      status: "ok",
      reason: null,
      source: null,
      files: [],
      pending: null,
      ...entry,
    })),
    unrecorded,
  };
}

interface Request {
  kind: string;
  integrationId?: string;
  outcome?: string;
  extensionId?: string;
  source?: unknown;
}

/** Answer every operation; inspections come from `snapshots` in turn. */
function agentAnswers(
  snapshots: Array<ReturnType<typeof snapshot>>,
  adopt: (request: Request) => unknown = (request) => ({
    integrationId: request.integrationId,
    status: "recorded",
    reason: null,
  }),
) {
  let read = 0;
  executeMock.mockImplementation(async (_client, operation) => {
    const request = operation as Request;
    if (request.kind === "installedIntegrations.inspect") {
      const answer = snapshots[Math.min(read, snapshots.length - 1)];
      read += 1;
      return answer as never;
    }
    if (request.kind === "integration.settle") {
      return {
        integrationId: request.integrationId,
        outcome: request.outcome,
        changed: true,
      } as never;
    }
    if (request.kind === "integration.adopt") return adopt(request) as never;
    throw new Error(`unexpected ${request.kind}`);
  });
}

function requests(kind: string): Request[] {
  return executeMock.mock.calls
    .map(([, operation]) => operation as Request)
    .filter((operation) => operation.kind === kind);
}

function silentLog() {
  return { info: vi.fn(), warn: vi.fn() };
}

afterEach(() => {
  executeMock.mockReset();
  vi.clearAllMocks();
});

describe("agent integration client", () => {
  it("returns the publish answer as given, for the caller to check after recording it", async () => {
    executeMock.mockResolvedValueOnce({
      integrationId: "intg-other",
      transactionId: PENDING,
      manifestSha256: SHA,
    } as never);

    await expect(
      integrations.publishIntegration(
        {
          integrationId: "intg-one",
          source: { kind: "artifact", url: ARTIFACT, sha256: SHA },
          extensionId: "bundle-x",
        },
        { operationKey: "opk1_key" },
      ),
    ).resolves.toMatchObject({ integrationId: "intg-other", transactionId: PENDING });
    expect(executeMock).toHaveBeenCalledWith(
      {},
      {
        kind: "integration.publish",
        integrationId: "intg-one",
        source: { kind: "artifact", url: ARTIFACT, sha256: SHA },
        extensionId: "bundle-x",
      },
      "opk1_key",
      { signal: undefined },
    );
  });

  it.each([
    [
      "settle",
      () =>
        integrations.settleIntegration(
          { integrationId: "intg-one", transactionId: PENDING, outcome: "commit" },
          { operationKey: "opk1_key" },
        ),
      { integrationId: "intg-two", outcome: "commit", changed: true },
    ],
    [
      "remove",
      () =>
        integrations.removeIntegration(
          { integrationId: "intg-one", extensionId: "bundle-x" },
          { operationKey: "opk1_key" },
        ),
      { integrationId: "intg-two", removed: true },
    ],
    [
      "adopt",
      () =>
        integrations.adoptIntegration({ integrationId: "intg-one" }, { operationKey: "opk1_key" }),
      { integrationId: "intg-two", status: "recorded", reason: null },
    ],
  ])("refuses a %s answer about a different integration", async (_kind, call, answer) => {
    executeMock.mockResolvedValueOnce(answer as never);
    await expect(call()).rejects.toThrow(/different integration/);
  });

  it("refuses a settle answer with a different outcome", async () => {
    executeMock.mockResolvedValueOnce({
      integrationId: "intg-one",
      outcome: "rollback",
      changed: true,
    } as never);
    await expect(
      integrations.settleIntegration(
        { integrationId: "intg-one", transactionId: PENDING, outcome: "commit" },
        { operationKey: "opk1_key" },
      ),
    ).rejects.toThrow(/different integration change/);
  });
});

describe("recoverAgentIntegrations", () => {
  it("commits a pending transaction the row records and rolls back any other", async () => {
    agentAnswers([
      snapshot([
        { integrationId: "intg-one", extensionId: "bundle-x", pending: { transactionId: PENDING } },
        { integrationId: "intg-two", extensionId: "bundle-x", pending: { transactionId: OTHER } },
      ]),
    ]);
    dbMock.queueSelect([{ lastTransactionId: PENDING }]);
    // The row still records an earlier install of the second integration.
    dbMock.queueSelect([{ lastTransactionId: `itx1_${"f".repeat(24)}` }]);
    dbMock.queueSelect([]);

    const outcome = await integrations.recoverAgentIntegrations({ log: silentLog() });

    expect(requests("integration.settle")).toEqual([
      {
        kind: "integration.settle",
        integrationId: "intg-one",
        transactionId: PENDING,
        outcome: "commit",
      },
      {
        kind: "integration.settle",
        integrationId: "intg-two",
        transactionId: OTHER,
        outcome: "rollback",
      },
    ]);
    expect(outcome).toMatchObject({ committed: ["intg-one"], rolledBack: ["intg-two"] });
  });

  it("rolls back a pending transaction without a row (an interrupted fresh install)", async () => {
    agentAnswers([
      snapshot([{ integrationId: "intg-one", pending: { transactionId: PENDING } }]),
      snapshot([]),
    ]);
    dbMock.queueSelect([]);
    dbMock.queueSelect([]);

    const outcome = await integrations.recoverAgentIntegrations({ log: silentLog() });

    expect(requests("integration.settle").map((request) => request.outcome)).toEqual(["rollback"]);
    // Adoption reads what the rollback left.
    expect(requests("installedIntegrations.inspect")).toHaveLength(2);
    expect(outcome.rolledBack).toEqual(["intg-one"]);
  });

  it("settles transactions before adopting anything", async () => {
    agentAnswers([
      snapshot([{ integrationId: "intg-one", pending: { transactionId: PENDING } }], ["intg-old"]),
    ]);
    dbMock.queueSelect([{ lastTransactionId: PENDING }]);
    dbMock.queueSelect([
      { id: "intg-one", managedByExtension: "bundle-x" },
      { id: "intg-old", managedByExtension: null },
    ]);

    await integrations.recoverAgentIntegrations({ log: silentLog() });

    const kinds = executeMock.mock.calls.map(([, operation]) => (operation as Request).kind);
    expect(kinds).toEqual([
      "installedIntegrations.inspect",
      "integration.settle",
      "integration.adopt",
    ]);
  });

  it("adopts an unrecorded row with the artifact its extension snapshot names", async () => {
    agentAnswers([snapshot([{ integrationId: "intg-ok", extensionId: "bundle-y" }], ["intg-one"])]);
    dbMock.queueSelect([
      { id: "intg-ok", managedByExtension: "bundle-y" },
      { id: "intg-one", managedByExtension: "bundle-x" },
    ]);
    dbMock.queueSelect([
      {
        id: "bundle-x",
        manifest: {
          id: "bundle-x",
          integrations: [{ id: "intg-one", artifact: ARTIFACT, sha256: SHA }],
        },
      },
    ]);
    const log = silentLog();

    const outcome = await integrations.recoverAgentIntegrations({ log });

    expect(requests("integration.adopt")).toEqual([
      {
        kind: "integration.adopt",
        integrationId: "intg-one",
        extensionId: "bundle-x",
        source: { kind: "artifact", url: ARTIFACT, sha256: SHA },
      },
    ]);
    expect(outcome.adopted).toEqual(["intg-one"]);
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining('adopted integration "intg-one"'),
    );
  });

  it("adopts without a source when nothing names a usable artifact, and reports needs_reinstall", async () => {
    agentAnswers([snapshot([], ["intg-one"])], (request) => ({
      integrationId: request.integrationId,
      status: "needs_reinstall",
      reason: "Nothing records the archive it was installed from.",
    }));
    dbMock.queueSelect([
      // Absent from the agent entirely (no directory, no record).
      { id: "intg-gone", managedByExtension: null },
      { id: "intg-one", managedByExtension: "bundle-x" },
    ]);
    dbMock.queueSelect([
      {
        id: "bundle-x",
        manifest: { integrations: [{ id: "intg-one", artifact: "http://insecure", sha256: SHA }] },
      },
    ]);
    const log = silentLog();

    const outcome = await integrations.recoverAgentIntegrations({ log });

    expect(requests("integration.adopt")).toEqual([
      { kind: "integration.adopt", integrationId: "intg-gone" },
      { kind: "integration.adopt", integrationId: "intg-one", extensionId: "bundle-x" },
    ]);
    expect(outcome.adopted).toEqual([]);
    expect(outcome.needsReinstall.map((entry) => entry.integrationId)).toEqual([
      "intg-gone",
      "intg-one",
    ]);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('Integration "intg-one" needs to be reinstalled'),
    );
  });

  it("gives every adoption attempt its own key, so a failed download is retried", async () => {
    agentAnswers([snapshot([], ["intg-one"])]);
    dbMock.queueSelect([{ id: "intg-one", managedByExtension: null }]);
    dbMock.queueSelect([{ id: "intg-one", managedByExtension: null }]);

    await integrations.recoverAgentIntegrations({ log: silentLog() });
    await integrations.recoverAgentIntegrations({ log: silentLog() });

    const keys = executeMock.mock.calls
      .filter(([, operation]) => (operation as Request).kind === "integration.adopt")
      .map(([, , key]) => key);
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("never fails recovery when one adoption fails", async () => {
    let adoptions = 0;
    agentAnswers([snapshot([], ["intg-one", "intg-two"])], (request) => {
      adoptions += 1;
      if (adoptions === 1) throw new Error("agent busy");
      return { integrationId: request.integrationId, status: "recorded", reason: null };
    });
    dbMock.queueSelect([
      { id: "intg-one", managedByExtension: null },
      { id: "intg-two", managedByExtension: null },
    ]);
    const log = silentLog();

    const outcome = await integrations.recoverAgentIntegrations({ log });

    expect(outcome.adopted).toEqual(["intg-two"]);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("could not adopt"));
  });

  it("reports unrecorded directories no row names, without adopting them", async () => {
    agentAnswers([snapshot([], ["stray"])]);
    dbMock.queueSelect([]);
    const log = silentLog();

    await integrations.recoverAgentIntegrations({ log });

    expect(requests("integration.adopt")).toEqual([]);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("custom_integrations/stray"));
  });

  it("does not adopt what the agent already records, whatever its status", async () => {
    agentAnswers([
      snapshot([
        { integrationId: "intg-one", status: "needs_reinstall", reason: "manifest changed" },
      ]),
    ]);
    dbMock.queueSelect([{ id: "intg-one", managedByExtension: null }]);

    const outcome = await integrations.recoverAgentIntegrations({ log: silentLog() });

    expect(requests("integration.adopt")).toEqual([]);
    expect(outcome).toEqual({ committed: [], rolledBack: [], adopted: [], needsReinstall: [] });
  });
});

describe("readLoadableIntegrations", () => {
  // These share the module's last-reported state and run in order.
  const previousUrl = process.env.OPS_AGENT_URL;
  afterEach(() => {
    vi.useRealTimers();
    if (previousUrl === undefined) delete process.env.OPS_AGENT_URL;
    else process.env.OPS_AGENT_URL = previousUrl;
  });

  it("returns null without an operations agent, so the directory is scanned", async () => {
    delete process.env.OPS_AGENT_URL;
    await expect(integrations.readLoadableIntegrations()).resolves.toBeNull();
    expect(executeMock).not.toHaveBeenCalled();
  });

  it("offers only the integrations the agent reports intact", async () => {
    process.env.OPS_AGENT_URL = "http://ops-agent:8080";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const files = [{ path: "manifest.json", sha256: SHA }];
    agentAnswers([
      snapshot(
        [
          { integrationId: "intg-one", files },
          { integrationId: "intg-two", status: "needs_reinstall", reason: "manifest changed" },
        ],
        ["stray"],
      ),
    ]);

    await expect(integrations.readLoadableIntegrations()).resolves.toEqual([
      { integrationId: "intg-one", files },
    ]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"intg-two" is not loaded'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("custom_integrations/stray"));
    warn.mockRestore();
  });

  it("keeps the last reported list while the agent is unreachable and retries after a minute", async () => {
    process.env.OPS_AGENT_URL = "http://ops-agent:8080";
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    executeMock.mockRejectedValueOnce(new Error("connection refused"));
    const onChange = vi.fn();

    await expect(integrations.readLoadableIntegrations({ onChange })).resolves.toEqual([
      { integrationId: "intg-one", files: [{ path: "manifest.json", sha256: SHA }] },
    ]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("loaded as last reported"));

    agentAnswers([snapshot([{ integrationId: "intg-three" }])]);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(onChange).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onChange).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
