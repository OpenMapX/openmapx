import type { LoadedIntegration, SubjectDataHandler } from "@openmapx/integration-framework";
import { afterEach, describe, expect, it, vi } from "vitest";
import { currentIntegrationScope, type IntegrationScope } from "../../integration-scope";
import { forgetSubjectDataHandler, registerSubjectDataHandlerFor } from "../extension-handlers";
import {
  collectExtensionParts,
  createExtensionSubjectData,
  ERASE_DEADLINE_MS,
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
    removeAll(integrationId: string): void;
  } = {
    handlerRows: () => [...handlers].sort(),
    pendingRows: (integrationId) => pending.filter((row) => row.integration_id === integrationId),
    add(integration_id, subject_user_id) {
      pending.push({ integration_id, subject_user_id, attempts: 0, last_error: null });
    },
    removeAll(integrationId) {
      for (let index = pending.length - 1; index >= 0; index -= 1)
        if (pending[index]?.integration_id === integrationId) pending.splice(index, 1);
    },
    async syncHandlers({ handling, stopped }) {
      for (const id of handling) handlers.add(id);
      for (const id of stopped) handlers.delete(id);
      const dropped = new Map<string, number>();
      for (let index = pending.length - 1; index >= 0; index -= 1) {
        const id = pending[index]?.integration_id ?? "";
        if (!stopped.includes(id)) continue;
        pending.splice(index, 1);
        dropped.set(id, (dropped.get(id) ?? 0) + 1);
      }
      return dropped;
    },
    async pendingSubjects(integrationId) {
      // Fewest attempts first; the array keeps the order of recording.
      return store
        .pendingRows(integrationId)
        .map((row, index) => ({ row, index }))
        .sort((a, b) => a.row.attempts - b.row.attempts || a.index - b.index)
        .map(({ row }) => row.subject_user_id);
    },
    async pendingSummary() {
      const summary = new Map<string, { count: number; attempts: number }>();
      for (const row of pending) {
        const entry = summary.get(row.integration_id) ?? { count: 0, attempts: 0 };
        entry.count += 1;
        entry.attempts = Math.max(entry.attempts, row.attempts);
        summary.set(row.integration_id, entry);
      }
      return summary;
    },
    async recordStalled(integrationId, subjectId, error) {
      const row = pending.find(
        (candidate) =>
          candidate.integration_id === integrationId && candidate.subject_user_id === subjectId,
      );
      if (!row) return;
      row.attempts += 1;
      row.last_error = error;
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
  /** The attention items, by key, as the list holds them. */
  const items = new Map<string, { title: string; detail?: string }>();
  const attention = {
    raise: vi.fn(async (input: { key: string; title: string; detail?: string }) => {
      items.set(input.key, {
        title: input.title,
        ...(input.detail ? { detail: input.detail } : {}),
      });
      return "inserted" as const;
    }),
    resolve: vi.fn(async (key: string) => {
      items.delete(key);
    }),
    openKeys: vi.fn(async (prefix: string) =>
      [...items.keys()].filter((key) => key.startsWith(prefix)),
    ),
  };
  const log = { warn: vi.fn() };
  const subjectData = createExtensionSubjectData({
    store,
    integrations: () => registry,
    attention,
    log,
  });
  return { ...subjectData, attention, log, items };
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
  it("unlists only an integration that runs without a handler and keeps every other row", async () => {
    const a = integration("a");
    withHandler(a, async () => {});
    const store = memoryStore({
      handlers: ["b", "c", "d", "skipped"],
      pending: [
        ["b", "u1"],
        ["b", "u2"],
        ["c", "u1"],
        ["d", "u1"],
        ["skipped", "u1"],
      ],
    });
    const registry = [
      a,
      integration("b"),
      integration("c", { loadState: "failed" }),
      integration("d", { enabled: false }),
      integration("e", { loadState: "safe-mode" }),
    ];
    const { syncSubjectHandlerTable, attention, log } = setup(store, registry);

    await syncSubjectHandlerTable();

    // "skipped" is installed but the loader left it out of the registry, or
    // it was uninstalled with its data kept: deletions are still recorded.
    expect(store.handlerRows()).toEqual(["a", "c", "d", "skipped"]);
    expect(store.pendingRows("b")).toEqual([]);
    expect(store.pendingRows("c")).toHaveLength(1);
    expect(store.pendingRows("d")).toHaveLength(1);
    expect(store.pendingRows("skipped")).toHaveLength(1);
    expect(attention.resolve.mock.calls).toEqual([["subject-erasure-pending:b"]]);
    expect(log.warn).toHaveBeenCalledOnce();
    expect(log.warn).toHaveBeenCalledWith(
      { integrationId: "b", dropped: 2 },
      "Dropped 2 owed erasures of integration b: it runs without a subject-data handler, so it no longer erases data",
    );
  });

  it("drops nothing and logs nothing for an integration that runs without a handler and owes nothing", async () => {
    const store = memoryStore({ handlers: ["b"] });
    const { syncSubjectHandlerTable, attention, log } = setup(store, [integration("b")]);
    await syncSubjectHandlerTable();
    expect(store.handlerRows()).toEqual([]);
    expect(attention.resolve).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
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

    expect(attention.raise).toHaveBeenCalledWith({
      key: "subject-erasure-pending:a",
      severity: "warning",
      source: "privacy",
      title: "Erasure pending in Demo A",
      detail:
        "1 deleted account waits for this extension to erase its data; erasing has failed up to 1 time per account. Last error: boom. Repair or update the extension, or remove its data.",
    });
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

  it("shortens the recorded error to 2 000 characters and leaves an empty one out of the item's text", async () => {
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
    expect(raisedForB?.detail).toBe(
      "1 deleted account waits for this extension to erase its data; erasing has failed up to 1 time per account. Repair or update the extension, or remove its data.",
    );
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
      expect.objectContaining({
        detail: expect.stringContaining("Last error: Erase did not finish within 30 seconds."),
      }),
    );
    // A second run does not call into a handler that is still busy; the
    // erase that hangs counts as failed once more, which the item shows.
    expect(await runPendingErasures()).toEqual({ erased: 0, failed: 1 });
    expect(eraseA).toHaveBeenCalledTimes(1);
    expect(store.pendingRows("a").map((row) => [row.subject_user_id, row.attempts])).toEqual([
      ["u1", 2],
      ["u2", 0],
    ]);
    expect(store.pendingRows("a")[0]?.last_error).toBe(
      "The erase call that passed its 30-second deadline has still not settled",
    );
    expect(attention.raise).toHaveBeenLastCalledWith(
      expect.objectContaining({
        detail: expect.stringContaining("erasing has failed up to 2 times per account"),
      }),
    );

    first.settle?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(await runPendingErasures()).toEqual({ erased: 2, failed: 0 });
    expect(store.pendingRows("a")).toEqual([]);
    expect(attention.resolve).toHaveBeenLastCalledWith("subject-erasure-pending:a");
  });

  it("does not let one account whose erase keeps overrunning hold up the others", async () => {
    vi.useFakeTimers();
    const a = integration("a");
    const settleLate: Array<() => void> = [];
    const eraseA = vi.fn(
      (subjectId: string) =>
        new Promise<void>((resolve) => {
          if (subjectId === "u1") settleLate.push(resolve);
          else resolve();
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
    const { runPendingErasures } = setup(store, [a]);

    const first = runPendingErasures();
    await vi.advanceTimersByTimeAsync(ERASE_DEADLINE_MS);
    expect(await first).toEqual({ erased: 0, failed: 1 });
    // The overrunning call settles later, so the handler is free again.
    for (const settle of settleLate.splice(0)) settle();
    await vi.advanceTimersByTimeAsync(0);

    // The account that overran goes last now; the other one is erased first.
    const second = runPendingErasures();
    await vi.advanceTimersByTimeAsync(ERASE_DEADLINE_MS);
    expect(await second).toEqual({ erased: 1, failed: 1 });
    expect(eraseA.mock.calls.map(([subjectId]) => subjectId)).toEqual(["u1", "u2", "u1"]);
    expect(store.pendingRows("a").map((row) => [row.subject_user_id, row.attempts])).toEqual([
      ["u1", 2],
    ]);
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

  it.each([
    [
      "failed to load",
      integration("c", { loadState: "failed", name: "Trips" }),
      "Trips cannot erase data now: it failed to load.",
    ],
    [
      "is disabled by the operator",
      integration("c", { enabled: false, name: "Trips" }),
      "Trips cannot erase data now: it is disabled.",
    ],
    [
      "is incompatible",
      integration("c", { loadState: "incompatible", name: "Trips" }),
      "Trips cannot erase data now: it is not compatible with this version of OpenMapX.",
    ],
    [
      "is held back by safe mode",
      integration("c", { loadState: "safe-mode", name: "Trips" }),
      "Trips cannot erase data now: the API runs in safe mode.",
    ],
  ])(
    "shows owed erasures of an integration that %s, and clears the item once nothing is owed",
    async (_label, waiting, reason) => {
      const store = memoryStore({
        handlers: ["c"],
        pending: [
          ["c", "u1"],
          ["c", "u2"],
        ],
      });
      const { runPendingErasures, items } = setup(store, [waiting]);

      await runPendingErasures();

      expect(items.get("subject-erasure-pending:c")).toEqual({
        title: "Erasure pending in Trips",
        detail: `${reason} 2 deleted accounts wait for it to erase their data. Enable or repair the extension, reinstall it, or remove its data.`,
      });

      store.removeAll("c");
      await runPendingErasures();
      expect(items.has("subject-erasure-pending:c")).toBe(false);
    },
  );

  it("shows owed erasures of an integration that is not in the registry, by its id", async () => {
    const store = memoryStore({ handlers: ["gone"], pending: [["gone", "u1"]] });
    const { runPendingErasures, items } = setup(store, []);

    await runPendingErasures();

    expect(items.get("subject-erasure-pending:gone")).toEqual({
      title: "Erasure pending in gone",
      detail:
        "gone cannot erase data now: it is not installed, or its installation could not be loaded. 1 deleted account waits for it to erase their data. Enable or repair the extension, reinstall it, or remove its data.",
    });
  });

  it("keeps an export that hangs from holding up erasures, and a late export from freeing a hung erase", async () => {
    vi.useFakeTimers();
    const a = integration("a");
    const hungExports: Array<() => void> = [];
    const hungErases: Array<() => void> = [];
    // Only the first erase hangs.
    const eraseA = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          if (eraseA.mock.calls.length > 1) resolve();
          else hungErases.push(resolve);
        }),
    );
    registerSubjectDataHandlerFor(a, scopeOf(a), {
      erase: eraseA,
      export: () =>
        new Promise((resolve) => {
          hungExports.push(() => resolve(null));
        }),
    });
    const store = memoryStore({ handlers: ["a"], pending: [["a", "u1"]] });
    const { runPendingErasures } = setup(store, [a]);
    const ask = () =>
      collectExtensionParts({
        requestId: "case-1",
        userId: "subject-1",
        integrations: [a],
        listed: async () => ["a"],
        schemas: async () => [],
        log: { warn: () => {} },
        exportDeadlineMs: 1_000,
      });

    const exporting = ask();
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await exporting)[0]?.warningCodes).toEqual(["extension-handler-failed"]);

    // The hung export does not stop the erase.
    const erasing = runPendingErasures();
    await vi.advanceTimersByTimeAsync(ERASE_DEADLINE_MS);
    expect(await erasing).toEqual({ erased: 0, failed: 1 });
    expect(eraseA).toHaveBeenCalledTimes(1);

    // The export settles late; the erase is still hung and is not called again.
    for (const settle of hungExports.splice(0)) settle();
    await vi.advanceTimersByTimeAsync(0);
    expect(await runPendingErasures()).toEqual({ erased: 0, failed: 1 });
    expect(eraseA).toHaveBeenCalledTimes(1);

    for (const settle of hungErases.splice(0)) settle();
    await vi.advanceTimersByTimeAsync(0);
    expect(await runPendingErasures()).toEqual({ erased: 1, failed: 0 });
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

describe("daily erasure run", () => {
  it("brings the handler table in line before it works through the pending erasures", async () => {
    const a = integration("a");
    const eraseA = vi.fn(async () => {});
    withHandler(a, eraseA);
    const store = memoryStore({ pending: [["a", "u1"]] });
    const order: string[] = [];
    const syncHandlers = store.syncHandlers;
    store.syncHandlers = async (input) => {
      order.push("sync");
      return syncHandlers(input);
    };
    const eraseLocked = store.eraseLocked;
    store.eraseLocked = async (...args) => {
      order.push("erase");
      return eraseLocked(...args);
    };
    const { syncAndRunPendingErasures } = setup(store, [a]);

    expect(await syncAndRunPendingErasures()).toEqual({ erased: 1, failed: 0 });

    expect(order).toEqual(["sync", "erase"]);
    expect(store.handlerRows()).toEqual(["a"]);
  });

  it("still works through the pending erasures when the sync fails, and never rejects", async () => {
    const a = integration("a");
    withHandler(a, async () => {});
    const store = memoryStore({ handlers: ["a"], pending: [["a", "u1"]] });
    store.syncHandlers = async () => {
      throw new Error("database unavailable");
    };
    const { syncAndRunPendingErasures, log } = setup(store, [a]);

    expect(await syncAndRunPendingErasures()).toEqual({ erased: 1, failed: 0 });
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      "Could not update the list of integrations with a subject-data handler",
    );
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
