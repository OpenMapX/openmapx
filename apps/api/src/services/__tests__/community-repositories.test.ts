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

function pendingRepository(repository: string, transactionId: string) {
  return {
    repository,
    url: URL,
    commit: COMMIT,
    extensionId: "bundle-x",
    pending: {
      transactionId,
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
  it("does nothing when no transaction is pending", async () => {
    executeMock.mockResolvedValueOnce(snapshot([]) as never);
    const restoreSelection = vi.fn();

    await expect(
      repositories.reconcileCommunityRepositoryTransactions({ restoreSelection }),
    ).resolves.toEqual({
      runtimeRecoveryNeeded: false,
      orphanedServiceIds: [],
      restartServiceIds: [],
    });
    expect(restoreSelection).not.toHaveBeenCalled();
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  it("commits a transaction the database recorded", async () => {
    const repository = "1".repeat(16);
    executeMock.mockResolvedValueOnce(
      snapshot([pendingRepository(repository, TRANSACTION)]) as never,
    );
    executeMock.mockResolvedValueOnce({ repository, outcome: "commit", changed: true } as never);
    dbMock.queueSelect([{ lastTransactionId: TRANSACTION }]);
    const restoreSelection = vi.fn();
    const persistRuntimeRecovery = vi.fn();

    const result = await repositories.reconcileCommunityRepositoryTransactions({
      restoreSelection,
      persistRuntimeRecovery,
    });

    expect(result.runtimeRecoveryNeeded).toBe(false);
    expect(executeMock).toHaveBeenLastCalledWith(
      {},
      {
        kind: "serviceRepository.settle",
        repository,
        transactionId: TRANSACTION,
        outcome: "commit",
      },
      expect.any(String),
      { signal: undefined },
    );
    expect(restoreSelection).not.toHaveBeenCalled();
    expect(persistRuntimeRecovery).not.toHaveBeenCalled();
  });

  it("records runtime repair and restores the selection before rolling back an unrecorded transaction", async () => {
    const repository = "1".repeat(16);
    executeMock.mockResolvedValueOnce(
      snapshot([pendingRepository(repository, TRANSACTION)]) as never,
    );
    // The database still records the previous install's transaction.
    dbMock.queueSelect([{ lastTransactionId: `txn1_${"f".repeat(24)}` }]);
    const order: string[] = [];
    const restoreSelection = vi.fn(async () => {
      order.push("selection");
    });
    const persistRuntimeRecovery = vi.fn(async () => {
      order.push("runtime");
    });
    executeMock.mockImplementationOnce(async () => {
      order.push("settle");
      return { repository, outcome: "rollback", changed: true } as never;
    });

    const result = await repositories.reconcileCommunityRepositoryTransactions({
      restoreSelection,
      persistRuntimeRecovery,
    });

    expect(order).toEqual(["runtime", "selection", "settle"]);
    expect(restoreSelection).toHaveBeenCalledWith(["valhalla"], result.incidentId);
    expect(result).toMatchObject({
      runtimeRecoveryNeeded: true,
      orphanedServiceIds: ["svc-one"],
      restartServiceIds: ["svc-two"],
      incidentId: expect.stringMatching(/^recovery_[a-f0-9]{64}$/),
    });
    expect(executeMock).toHaveBeenLastCalledWith(
      {},
      expect.objectContaining({ kind: "serviceRepository.settle", outcome: "rollback" }),
      expect.any(String),
      { signal: undefined },
    );
  });

  it("rolls back a transaction for a repository the database never recorded", async () => {
    const repository = "2".repeat(16);
    executeMock.mockResolvedValueOnce(
      snapshot([pendingRepository(repository, TRANSACTION)]) as never,
    );
    executeMock.mockResolvedValueOnce({ repository, outcome: "rollback", changed: true } as never);
    dbMock.queueSelect([]);

    const result = await repositories.reconcileCommunityRepositoryTransactions();

    expect(result.runtimeRecoveryNeeded).toBe(true);
    expect(executeMock).toHaveBeenLastCalledWith(
      {},
      expect.objectContaining({ repository, outcome: "rollback" }),
      expect.any(String),
      { signal: undefined },
    );
  });

  it("does not settle when restoring the selection fails, so recovery can retry", async () => {
    const repository = "1".repeat(16);
    executeMock.mockResolvedValueOnce(
      snapshot([pendingRepository(repository, TRANSACTION)]) as never,
    );
    dbMock.queueSelect([]);

    await expect(
      repositories.reconcileCommunityRepositoryTransactions({
        restoreSelection: vi.fn().mockRejectedValue(new Error("selection unavailable")),
      }),
    ).rejects.toThrow("selection unavailable");
    expect(executeMock).toHaveBeenCalledTimes(1);
  });
});
