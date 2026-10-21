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

let repositories: typeof import("../community-repositories.js");
beforeAll(async () => {
  repositories = await import("../community-repositories.js");
}, 30_000);

const executeMock = vi.mocked(executeAndWait);

const URL = "https://github.com/example/services.git";
const COMMIT = "a".repeat(40);
const TRANSACTION = `txn1_${"b".repeat(24)}`;

function manifest(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: id,
    version: "1.0.0",
    quality: "community",
    container: {
      image: `registry.example.test/${id}`,
      tag: "1.0.0",
      digest: `sha256:${"c".repeat(64)}`,
    },
    ...overrides,
  };
}

function pendingRepository(
  repository: string,
  transactionId: string,
  phase: "published" | "rolledBack" = "published",
) {
  return {
    repository,
    url: URL,
    commit: COMMIT,
    extensionId: "bundle-x",
    pending: {
      transactionId,
      phase,
      previousCommit: null,
      recovery: {
        selectionBefore: ["valhalla"],
        touchedServiceIds: ["svc-one"],
        previouslyEnabledServiceIds: ["svc-two"],
      },
    },
  };
}

function snapshot(repositoriesList: unknown[]) {
  return {
    revisionId: `cfg1_${"d".repeat(43)}`,
    repositories: repositoriesList,
    services: [],
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("inspectServiceRepository", () => {
  it("canonicalizes the URL and checks the agent inspected that repository", async () => {
    const repository = repositories.hashUrl(URL);
    executeMock.mockResolvedValueOnce({
      url: URL,
      repository,
      commit: COMMIT,
      valid: true,
      problems: [],
      services: [{ path: "svc-one", manifest: manifest("svc-one") }],
    } as never);

    const result = await repositories.inspectServiceRepository(
      "https://GitHub.com/example//services.git",
      "v1",
      { operationKey: "opk1_key" },
    );

    expect(executeMock).toHaveBeenCalledWith(
      {},
      { kind: "serviceRepository.inspect", url: URL, ref: "v1" },
      "opk1_key",
      { signal: undefined },
    );
    expect(result).toMatchObject({ url: URL, repository, commit: COMMIT, valid: true });
    expect(result.services.map((service) => service.manifest.id)).toEqual(["svc-one"]);
  });

  it("revalidates reported manifests with the community rules", async () => {
    executeMock.mockResolvedValueOnce({
      url: URL,
      repository: repositories.hashUrl(URL),
      commit: COMMIT,
      valid: true,
      problems: [],
      services: [
        { path: "svc-one", manifest: manifest("svc-one") },
        { path: "svc-two", manifest: manifest("svc-two", { quality: "built-in" }) },
      ],
    } as never);

    const result = await repositories.inspectServiceRepository(URL, undefined, {
      operationKey: "opk1_key",
    });

    expect(result.valid).toBe(false);
    expect(result.services.map((service) => service.manifest.id)).toEqual(["svc-one"]);
    expect(result.problems).toEqual([expect.stringMatching(/^svc-two\/service\.json: /)]);
  });

  it("refuses an answer about a different repository", async () => {
    executeMock.mockResolvedValueOnce({
      url: URL,
      repository: "0".repeat(16),
      commit: COMMIT,
      valid: true,
      problems: [],
      services: [],
    } as never);

    await expect(
      repositories.inspectServiceRepository(URL, undefined, { operationKey: "opk1_key" }),
    ).rejects.toThrow("inspected a different repository");
  });

  it("refuses a URL outside the allowed Git hosts before asking the agent", async () => {
    await expect(
      repositories.inspectServiceRepository("https://intranet.example/repo.git", undefined, {
        operationKey: "opk1_key",
      }),
    ).rejects.toThrow();
    expect(executeMock).not.toHaveBeenCalled();
  });
});

describe("publishServiceRepository", () => {
  it("refuses an answer that installed a different commit", async () => {
    executeMock.mockResolvedValueOnce({
      repository: repositories.hashUrl(URL),
      commit: "e".repeat(40),
      transactionId: TRANSACTION,
      serviceIds: ["svc-one"],
    } as never);

    await expect(
      repositories.publishServiceRepository(
        {
          url: URL,
          commit: COMMIT,
          extensionId: "bundle-x",
          recovery: {
            selectionBefore: null,
            touchedServiceIds: [],
            previouslyEnabledServiceIds: [],
          },
        },
        { operationKey: "opk1_key" },
      ),
    ).rejects.toThrow("installed a different repository");
  });
});

describe("readCommunityServices", () => {
  it("drops reported services the community rules reject and reports why", async () => {
    executeMock.mockResolvedValueOnce({
      ...snapshot([]),
      services: [
        { repository: "1".repeat(16), directory: "/x/a", manifest: manifest("svc-one") },
        {
          repository: "1".repeat(16),
          directory: "/x/b",
          manifest: manifest("svc-two", { container: { image: "x", tag: "latest" } }),
        },
      ],
    } as never);

    const result = await repositories.readCommunityServices();

    expect(result.services.map((service) => service.manifest.id)).toEqual(["svc-one"]);
    expect(result.problems).toEqual([
      expect.stringContaining(`Community service in repository ${"1".repeat(16)} was rejected`),
    ]);
  });
});

describe("reconcileCommunityRepositoryTransactions", () => {
  /** The settle requests sent to the agent, in order. */
  function settled() {
    return executeMock.mock.calls
      .map(([, operation]) => operation as { kind: string; repository?: string; outcome?: string })
      .filter((operation) => operation.kind === "serviceRepository.settle")
      .map((operation) => `${operation.outcome}:${operation.repository}`);
  }

  function agentAnswers(repositoriesList: unknown[]) {
    executeMock.mockImplementation(async (_client, operation) => {
      const request = operation as { kind: string; repository?: string; outcome?: string };
      if (request.kind === "communityServices.inspect") return snapshot(repositoriesList) as never;
      return { repository: request.repository, outcome: request.outcome, changed: true } as never;
    });
  }

  afterEach(() => {
    executeMock.mockReset();
  });

  it("does nothing when no transaction is pending", async () => {
    agentAnswers([]);
    const restoreSelection = vi.fn();

    await expect(
      repositories.reconcileCommunityRepositoryTransactions({ restoreSelection }),
    ).resolves.toEqual({
      runtimeRecoveryNeeded: false,
      orphanedServiceIds: [],
      restartServiceIds: [],
    });
    expect(restoreSelection).not.toHaveBeenCalled();
    expect(settled()).toEqual([]);
  });

  it("commits a transaction the database recorded", async () => {
    const repository = "1".repeat(16);
    agentAnswers([pendingRepository(repository, TRANSACTION)]);
    dbMock.queueSelect([{ lastTransactionId: TRANSACTION }]);
    const restoreSelection = vi.fn();
    const persistRuntimeRecovery = vi.fn();

    const result = await repositories.reconcileCommunityRepositoryTransactions({
      restoreSelection,
      persistRuntimeRecovery,
    });

    expect(result.runtimeRecoveryNeeded).toBe(false);
    expect(settled()).toEqual([`commit:${repository}`]);
    expect(restoreSelection).not.toHaveBeenCalled();
    expect(persistRuntimeRecovery).not.toHaveBeenCalled();
  });

  it("records runtime repair, rolls back, restores the selection, then releases", async () => {
    const one = "1".repeat(16);
    const two = "2".repeat(16);
    const otherTransaction = `txn1_${"c".repeat(24)}`;
    agentAnswers([pendingRepository(one, TRANSACTION), pendingRepository(two, otherTransaction)]);
    // The database still records an earlier install of the first repository.
    dbMock.queueSelect([{ lastTransactionId: `txn1_${"f".repeat(24)}` }]);
    dbMock.queueSelect([]);
    const order: string[] = [];
    const restoreSelection = vi.fn(async () => {
      order.push(`selection:${settled().join(",")}`);
    });
    const persistRuntimeRecovery = vi.fn(async () => {
      order.push(`runtime:${settled().join(",")}`);
    });

    const result = await repositories.reconcileCommunityRepositoryTransactions({
      restoreSelection,
      persistRuntimeRecovery,
    });

    // Runtime repair is recorded before anything changes; the selection is
    // restored once, after every checkout is back; notes are released last.
    expect(order).toEqual(["runtime:", `selection:rollback:${two},rollback:${one}`]);
    expect(settled()).toEqual([
      `rollback:${two}`,
      `rollback:${one}`,
      `release:${one}`,
      `release:${two}`,
    ]);
    expect(restoreSelection).toHaveBeenCalledTimes(1);
    expect(restoreSelection).toHaveBeenCalledWith(["valhalla"], result.incidentId);
    expect(result).toMatchObject({
      runtimeRecoveryNeeded: true,
      orphanedServiceIds: ["svc-one"],
      restartServiceIds: ["svc-two"],
      incidentId: expect.stringMatching(/^recovery_[a-f0-9]{64}$/),
    });
  });

  it("finishes a rollback whose selection restore failed earlier", async () => {
    const repository = "1".repeat(16);
    agentAnswers([pendingRepository(repository, TRANSACTION, "rolledBack")]);
    const restoreSelection = vi.fn();

    await repositories.reconcileCommunityRepositoryTransactions({ restoreSelection });

    // A rolled-back transaction is never committed, whatever the database says.
    expect(dbMock.db.select).not.toHaveBeenCalled();
    expect(settled()).toEqual([`release:${repository}`]);
    expect(restoreSelection).toHaveBeenCalledWith(["valhalla"], expect.any(String));
  });

  it("keeps the recovery note when restoring the selection fails, so recovery can retry", async () => {
    const repository = "1".repeat(16);
    agentAnswers([pendingRepository(repository, TRANSACTION)]);
    dbMock.queueSelect([]);

    await expect(
      repositories.reconcileCommunityRepositoryTransactions({
        restoreSelection: vi.fn().mockRejectedValue(new Error("selection unavailable")),
      }),
    ).rejects.toThrow("selection unavailable");
    expect(settled()).toEqual([`rollback:${repository}`]);
  });
});
