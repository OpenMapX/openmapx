import type { LoadedIntegration, SubjectDataHandler } from "@openmapx/integration-framework";
import { afterEach, describe, expect, it, vi } from "vitest";
import { currentIntegrationScope, type IntegrationScope } from "../../integration-scope";
import {
  createExtensionSubjectData,
  ERASE_DEADLINE_MS,
  forgetSubjectDataHandler,
  registerSubjectDataHandlerFor,
  type SubjectErasureStore,
} from "../extension-subject-data";

interface PendingRow {
  integration_id: string;
  subject_user_id: string;
  attempts: number;
  last_error: string | null;
}

/** The two tables in memory, with the rules of the real store. */
function memoryStore(seed: { handlers?: string[]; pending?: Array<[string, string]> } = {}) {
  const handlers = new Set(seed.handlers ?? []);
  const pending: PendingRow[] = (seed.pending ?? []).map(([integration_id, subject_user_id]) => ({
    integration_id,
    subject_user_id,
    attempts: 0,
    last_error: null,
  }));
  const store: SubjectErasureStore & {
    handlerRows(): string[];
    pendingRows(integrationId: string): PendingRow[];
    add(integrationId: string, subjectId: string): void;
  } = {
    handlerRows: () => [...handlers].sort(),
    pendingRows: (integrationId) => pending.filter((row) => row.integration_id === integrationId),
    add(integration_id, subject_user_id) {
      pending.push({ integration_id, subject_user_id, attempts: 0, last_error: null });
    },
    async syncHandlers({ handling, stopped, known }) {
      for (const id of handling) handlers.add(id);
      for (const id of [...handlers]) {
        if (stopped.includes(id) || !known.includes(id)) handlers.delete(id);
      }
      for (let index = pending.length - 1; index >= 0; index -= 1) {
        if (stopped.includes(pending[index]?.integration_id ?? "")) pending.splice(index, 1);
      }
    },
    async pendingSubjects(integrationId) {
      return store.pendingRows(integrationId).map((row) => row.subject_user_id);
    },
    async eraseLocked(integrationId, subjectId, erase) {
      const row = pending.find(
        (candidate) =>
          candidate.integration_id === integrationId && candidate.subject_user_id === subjectId,
      );
      if (!row) return null;
      const attempt = await erase();
      if (attempt.ok) pending.splice(pending.indexOf(row), 1);
      else {
        row.attempts += 1;
        row.last_error = attempt.error;
      }
      return attempt;
    },
    async count(integrationIds) {
      return pending.filter((row) => integrationIds.includes(row.integration_id)).length;
    },
  };
  return store;
}

function integration(
  id: string,
  options: { loadState?: LoadedIntegration["loadState"]; enabled?: boolean; name?: string } = {},
): LoadedIntegration {
  return {
    id,
    manifest: {
      id,
      name: options.name ?? `Demo ${id.toUpperCase()}`,
    } as LoadedIntegration["manifest"],
    config: {},
    directory: `/integrations/${id}`,
    isBuiltIn: false,
    enabled: options.enabled ?? true,
    providers: new Map(),
    strings: {},
    loadState: options.loadState ?? "loaded",
    shutdownHandlers: [],
  };
}

function scopeOf(target: LoadedIntegration): IntegrationScope {
  return { integrationId: target.id, isBuiltIn: false, revoked: false };
}

function withHandler(
  target: LoadedIntegration,
  erase: (subjectId: string) => Promise<void>,
): SubjectDataHandler {
  const handler: SubjectDataHandler = { erase, export: async () => null };
  registerSubjectDataHandlerFor(target, scopeOf(target), handler);
  return handler;
}

function setup(store: ReturnType<typeof memoryStore>, registry: LoadedIntegration[]) {
  const attention = {
    raise: vi.fn(async (_input: { key: string; detail?: string }) => "inserted" as const),
    resolve: vi.fn(async () => {}),
  };
  const log = { warn: vi.fn() };
  const subjectData = createExtensionSubjectData({
    store,
    integrations: () => registry,
    attention,
    log,
  });
  return { ...subjectData, attention, log };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("subject-data handler registration", () => {
  it("accepts one handler per integration", () => {
    const target = integration("once");
    withHandler(target, async () => {});
    expect(() => withHandler(target, async () => {})).toThrow(
      "Integration once already registered a subject-data handler",
    );
    forgetSubjectDataHandler(target);
    expect(() => withHandler(target, async () => {})).not.toThrow();
  });

  it("refuses a handler without both functions", () => {
    const target = integration("partial");
    expect(() =>
      registerSubjectDataHandlerFor(target, scopeOf(target), {
        erase: async () => {},
      } as unknown as SubjectDataHandler),
    ).toThrow("Integration partial registered a subject-data handler without export and erase");
  });
});

describe("handler table", () => {
  it("lists integrations that registered a handler and unlists those that stopped", async () => {
    const a = integration("a");
    withHandler(a, async () => {});
    const store = memoryStore({
      handlers: ["b", "c", "d", "gone"],
      pending: [
        ["b", "u1"],
        ["c", "u1"],
        ["d", "u1"],
        ["gone", "u1"],
      ],
    });
    const registry = [
      a,
      integration("b"),
      integration("c", { loadState: "failed" }),
      integration("d", { enabled: false }),
      integration("e", { loadState: "safe-mode" }),
    ];
    const { syncSubjectHandlerTable } = setup(store, registry);

    await syncSubjectHandlerTable();

    expect(store.handlerRows()).toEqual(["a", "c", "d"]);
    expect(store.pendingRows("b")).toEqual([]);
    expect(store.pendingRows("c")).toHaveLength(1);
    expect(store.pendingRows("d")).toHaveLength(1);
    // Kept until the integration's data is removed or it returns.
    expect(store.pendingRows("gone")).toHaveLength(1);
  });

  it("keeps the rows of disabled, incompatible, failed and safe-mode integrations", async () => {
    const store = memoryStore({ handlers: ["p", "q", "r", "s"] });
    const { syncSubjectHandlerTable } = setup(store, [
      integration("p", { loadState: "disabled" }),
      integration("q", { loadState: "incompatible" }),
      integration("r", { loadState: "failed" }),
      integration("s", { loadState: "safe-mode" }),
    ]);
    await syncSubjectHandlerTable();
    expect(store.handlerRows()).toEqual(["p", "q", "r", "s"]);
  });
});

describe("pending erasures", () => {
  it("erases through the handler in the integration's scope and deletes the row", async () => {
    const a = integration("a");
    const scopes: Array<string | undefined> = [];
    const eraseA = vi.fn(async () => {
      scopes.push(currentIntegrationScope()?.integrationId);
    });
    withHandler(a, eraseA);
    const store = memoryStore({ handlers: ["a"], pending: [["a", "u1"]] });
    const { runPendingErasures, attention } = setup(store, [a]);

    expect(await runPendingErasures()).toEqual({ erased: 1, failed: 0 });

    expect(eraseA).toHaveBeenCalledWith("u1");
    expect(scopes).toEqual(["a"]);
    expect(store.pendingRows("a")).toEqual([]);
    expect(attention.resolve).toHaveBeenCalledWith("subject-erasure-pending:a");
    expect(attention.raise).not.toHaveBeenCalled();
  });

  it("keeps the row, counts the attempt and raises attention when the handler throws", async () => {
    const a = integration("a");
    withHandler(a, async () => {
      throw new Error("boom");
    });
    const store = memoryStore({ handlers: ["a"], pending: [["a", "u1"]] });
    const { runPendingErasures, attention } = setup(store, [a]);

    expect(await runPendingErasures()).toEqual({ erased: 0, failed: 1 });

    expect(attention.raise).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "subject-erasure-pending:a",
        severity: "warning",
        source: "privacy",
        title: "Erasure pending in Demo A",
        detail: "boom",
      }),
    );
    expect(attention.resolve).not.toHaveBeenCalled();
    expect(store.pendingRows("a")[0]).toMatchObject({
      attempts: 1,
      last_error: expect.stringContaining("boom"),
    });
  });

  it.each([
    ["an object without a prototype", () => Object.create(null), "a value that cannot be shown"],
    [
      "an Error whose message getter throws",
      () => {
        const error = new Error("hidden");
        Object.defineProperty(error, "message", {
          get() {
            throw new Error("getter");
          },
        });
        return error;
      },
      "a value that cannot be shown",
    ],
    ["a string", () => "plain text", "plain text"],
  ])("records a failure when erase rejects with %s", async (_label, value, expected) => {
    const a = integration("a");
    withHandler(a, () => Promise.reject(value()));
    const store = memoryStore({ handlers: ["a"], pending: [["a", "u1"]] });
    const { runPendingErasures } = setup(store, [a]);

    expect(await runPendingErasures()).toEqual({ erased: 0, failed: 1 });
    expect(store.pendingRows("a")[0]).toMatchObject({ attempts: 1, last_error: expected });
  });

  it("records a failure when erase throws before returning a promise", async () => {
    const a = integration("a");
    withHandler(a, (() => {
      throw new Error("at once");
    }) as unknown as (subjectId: string) => Promise<void>);
    const store = memoryStore({ handlers: ["a"], pending: [["a", "u1"]] });
    const { runPendingErasures } = setup(store, [a]);

    expect(await runPendingErasures()).toEqual({ erased: 0, failed: 1 });
    expect(store.pendingRows("a")[0]?.last_error).toBe("at once");
  });

  it("shortens the recorded error to 2 000 characters and leaves an empty one out of the item", async () => {
    const a = integration("a");
    const b = integration("b");
    withHandler(a, async () => {
      throw new Error("x".repeat(5_000));
    });
    withHandler(b, async () => {
      throw new Error("");
    });
    const store = memoryStore({
      handlers: ["a", "b"],
      pending: [
        ["a", "u1"],
        ["b", "u1"],
      ],
    });
    const { runPendingErasures, attention } = setup(store, [a, b]);

    await runPendingErasures();

    expect(store.pendingRows("a")[0]?.last_error).toHaveLength(2_000);
    const raisedForB = attention.raise.mock.calls
      .map(([input]) => input)
      .find((input) => input.key === "subject-erasure-pending:b");
    expect(raisedForB).toBeDefined();
    expect(raisedForB).not.toHaveProperty("detail");
  });

  it("keeps the row when the handler exceeds 30 seconds and leaves the integration until it settles", async () => {
    vi.useFakeTimers();
    const a = integration("a");
    // Only the first call hangs.
    const first: { settle?: () => void } = {};
    const eraseA = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          if (first.settle) resolve();
          else first.settle = resolve;
        }),
    );
    withHandler(a, eraseA);
    const store = memoryStore({
      handlers: ["a"],
      pending: [
        ["a", "u1"],
        ["a", "u2"],
      ],
    });
    const { runPendingErasures, attention } = setup(store, [a]);

    const run = runPendingErasures();
    await vi.advanceTimersByTimeAsync(ERASE_DEADLINE_MS - 1);
    expect(store.pendingRows("a")[0]?.attempts).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(await run).toEqual({ erased: 0, failed: 1 });

    expect(store.pendingRows("a").map((row) => [row.subject_user_id, row.attempts])).toEqual([
      ["u1", 1],
      ["u2", 0],
    ]);
    expect(store.pendingRows("a")[0]?.last_error).toBe("Erase did not finish within 30 seconds");
    expect(attention.raise).toHaveBeenCalledWith(
      expect.objectContaining({ detail: "Erase did not finish within 30 seconds" }),
    );
    // A second run does not call into a handler that is still busy.
    expect(await runPendingErasures()).toEqual({ erased: 0, failed: 0 });
    expect(eraseA).toHaveBeenCalledTimes(1);

    first.settle?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(await runPendingErasures()).toEqual({ erased: 2, failed: 0 });
    expect(store.pendingRows("a")).toEqual([]);
  });

  it("leaves rows of an integration that is not loaded and replays them when it loads", async () => {
    const store = memoryStore({
      handlers: ["c"],
      pending: [
        ["c", "u1"],
        ["c", "u2"],
      ],
    });
    const registry = [integration("c", { loadState: "failed" })];
    const { runPendingErasures, syncSubjectHandlerTable, attention } = setup(store, registry);

    expect(await runPendingErasures()).toEqual({ erased: 0, failed: 0 });
    expect(store.pendingRows("c")).toHaveLength(2);
    expect(attention.resolve).not.toHaveBeenCalled();

    const loaded = integration("c");
    const eraseC = vi.fn(async () => {});
    withHandler(loaded, eraseC);
    registry[0] = loaded;
    await syncSubjectHandlerTable();
    expect(await runPendingErasures()).toEqual({ erased: 2, failed: 0 });

    expect(eraseC.mock.calls).toEqual([["u1"], ["u2"]]);
    expect(store.pendingRows("c")).toEqual([]);
    expect(attention.resolve).toHaveBeenCalledWith("subject-erasure-pending:c");
  });

  it("works through one integration when it is named", async () => {
    const a = integration("a");
    const b = integration("b");
    const eraseA = vi.fn(async () => {});
    const eraseB = vi.fn(async () => {});
    withHandler(a, eraseA);
    withHandler(b, eraseB);
    const store = memoryStore({
      handlers: ["a", "b"],
      pending: [
        ["a", "u1"],
        ["b", "u1"],
      ],
    });
    const { runPendingErasures } = setup(store, [a, b]);

    expect(await runPendingErasures("b")).toEqual({ erased: 1, failed: 0 });
    expect(eraseA).not.toHaveBeenCalled();
    expect(store.pendingRows("a")).toHaveLength(1);
  });

  it("runs one pass at a time and erases each row once when runs overlap", async () => {
    const a = integration("a");
    const eraseA = vi.fn(async () => {});
    withHandler(a, eraseA);
    const store = memoryStore({ handlers: ["a"], pending: [["a", "u1"]] });
    const { runPendingErasures } = setup(store, [a]);

    const results = await Promise.all([
      runPendingErasures("a"),
      runPendingErasures("a"),
      runPendingErasures(),
    ]);

    expect(eraseA).toHaveBeenCalledTimes(1);
    expect(results[0]).toEqual({ erased: 1, failed: 0 });
  });

  it("goes on when the store or the attention list fails", async () => {
    const a = integration("a");
    const b = integration("b");
    withHandler(a, async () => {
      throw new Error("boom");
    });
    const eraseB = vi.fn(async () => {});
    withHandler(b, eraseB);
    const store = memoryStore({
      handlers: ["a", "b"],
      pending: [
        ["a", "u1"],
        ["b", "u1"],
      ],
    });
    const pendingSubjects = store.pendingSubjects;
    store.pendingSubjects = async (integrationId) => {
      if (integrationId === "a") throw new Error("connection lost");
      return pendingSubjects(integrationId);
    };
    const { runPendingErasures, attention, log } = setup(store, [a, b]);
    attention.resolve.mockRejectedValue(new Error("attention unavailable"));

    expect(await runPendingErasures()).toEqual({ erased: 1, failed: 0 });
    expect(eraseB).toHaveBeenCalledWith("u1");
    expect(log.warn).toHaveBeenCalled();
  });
});

describe("pending erasure count", () => {
  it("counts pending erasures for an integration set", async () => {
    const store = memoryStore({
      pending: [
        ["c", "u1"],
        ["c", "u2"],
        ["a", "u1"],
      ],
    });
    const { pendingErasureCount } = setup(store, []);
    expect(await pendingErasureCount(["c"])).toBe(2);
    expect(await pendingErasureCount(["b"])).toBe(0);
    expect(await pendingErasureCount([])).toBe(0);
  });
});
