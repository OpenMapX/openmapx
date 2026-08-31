import { describe, expect, it, vi } from "vitest";
import {
  createActivationTransactionScope,
  runImmediateActivation,
} from "../activation-transaction";
import {
  createStagedRuntimeContext,
  createStagedRuntimeValue,
  stageRuntimeGeneration,
} from "../staged-runtime-context";

interface TestContext {
  id: string;
}

function context(id: string): TestContext {
  return { id };
}

describe("createStagedRuntimeContext", () => {
  it("fails fast before initialization", () => {
    const runtime = createStagedRuntimeContext<TestContext>("test");

    expect(() => runtime.get()).toThrow(
      "test runtime: integration context not initialised — call initRuntime(ctx) in setup()",
    );
  });

  it("publishes initialization immediately outside staging", () => {
    const runtime = createStagedRuntimeContext<TestContext>("test");

    runtime.init(context("active"));

    expect(runtime.get().id).toBe("active");
  });

  it("rejects nested staging and commits without an active transaction", () => {
    const runtime = createStagedRuntimeContext<TestContext>("test");

    expect(() => runtime.commit()).toThrow("test runtime staging is not active");
    runtime.begin();
    expect(() => runtime.begin()).toThrow("test runtime staging is already active");
  });

  it("publishes the staged context before running commit actions in order", () => {
    const runtime = createStagedRuntimeContext<TestContext>("test");
    const events: string[] = [];
    runtime.init(context("old"));
    runtime.begin();
    runtime.init(context("new"));
    runtime.stageCommit(() => events.push(`first:${runtime.get().id}`));
    runtime.stageCommit(() => events.push(`second:${runtime.get().id}`));

    expect(runtime.get().id).toBe("old");
    runtime.commit();

    expect(runtime.get().id).toBe("new");
    expect(events).toEqual(["first:new", "second:new"]);
  });

  it("restores a committed context and its actions when candidate publication fails", () => {
    const runtime = createStagedRuntimeContext<TestContext>("test");
    const events: string[] = [];
    runtime.init(context("old"));
    runtime.begin();
    runtime.init(context("new"));
    runtime.stageCommit(
      () => events.push("apply:first"),
      () => events.push("restore:first"),
    );
    runtime.stageCommit(
      () => events.push("apply:second"),
      () => events.push("restore:second"),
    );

    runtime.commit();
    expect(runtime.get().id).toBe("new");
    runtime.rollback();

    expect(runtime.get().id).toBe("old");
    expect(events).toEqual(["apply:first", "apply:second", "restore:second", "restore:first"]);
  });

  it("starts the next transaction from the last published context", () => {
    const runtime = createStagedRuntimeContext<TestContext>("test");
    runtime.init(context("old"));
    runtime.begin();
    runtime.init(context("published"));
    runtime.commit();

    runtime.begin();
    runtime.init(context("failed"));
    runtime.rollback();

    expect(runtime.get().id).toBe("published");
  });

  it("preserves the active context and discards actions on rollback", () => {
    const runtime = createStagedRuntimeContext<TestContext>("test");
    const action = vi.fn();
    runtime.init(context("old"));
    runtime.begin();
    runtime.init(context("failed"));
    runtime.stageCommit(action);

    runtime.rollback();

    expect(runtime.get().id).toBe("old");
    expect(action).not.toHaveBeenCalled();
  });

  it("runs commit actions immediately outside staging", () => {
    const runtime = createStagedRuntimeContext<TestContext>("test");
    const action = vi.fn();

    runtime.stageCommit(action);

    expect(action).toHaveBeenCalledOnce();
  });

  it("stages reversible configuration values with a runtime generation", () => {
    const runtime = createStagedRuntimeContext<TestContext>("test");
    const scope = createActivationTransactionScope();
    const applied: string[] = [];
    const configuration = createStagedRuntimeValue<string>((value) => applied.push(value));
    runtime.init(context("old"));
    configuration.stage(runtime, "old-config");
    applied.length = 0;

    stageRuntimeGeneration({ onActivate: scope.register }, runtime, context("new"), () => {
      configuration.stage(runtime, "new-config");
    });
    expect(runtime.get().id).toBe("old");

    scope.activate();
    expect(runtime.get().id).toBe("new");
    expect(applied).toEqual(["new-config"]);
    scope.rollback();

    expect(runtime.get().id).toBe("old");
    expect(applied).toEqual(["new-config", "old-config"]);
  });

  it("discards local staging when runtime preparation fails", () => {
    const runtime = createStagedRuntimeContext<TestContext>("test");
    const onActivate = vi.fn();
    runtime.init(context("old"));

    expect(() =>
      stageRuntimeGeneration({ onActivate }, runtime, context("failed"), () => {
        throw new Error("prepare failed");
      }),
    ).toThrow("prepare failed");

    expect(runtime.get().id).toBe("old");
    expect(onActivate).not.toHaveBeenCalled();
  });
});

describe("activation transaction scope", () => {
  it("activates registered transactions in order and completes them without rollback", () => {
    const events: string[] = [];
    const scope = createActivationTransactionScope();
    scope.register(
      () => events.push("activate:first"),
      () => events.push("rollback:first"),
    );
    scope.register(
      () => events.push("activate:second"),
      () => events.push("rollback:second"),
    );

    scope.activate();
    scope.complete();
    scope.rollback();

    expect(events).toEqual(["activate:first", "activate:second"]);
  });

  it("rolls back active and staged transactions once in reverse registration order", () => {
    const events: string[] = [];
    const scope = createActivationTransactionScope();
    scope.register(
      () => events.push("activate:first"),
      () => events.push("rollback:first"),
    );
    scope.register(
      () => {
        events.push("activate:second");
        throw new Error("activation failed");
      },
      () => events.push("rollback:second"),
    );
    scope.register(
      () => events.push("activate:third"),
      () => events.push("rollback:third"),
    );

    expect(() => scope.activate()).toThrow("activation failed");
    expect(scope.rollback()).toEqual([]);
    expect(scope.rollback()).toEqual([]);

    expect(events).toEqual([
      "activate:first",
      "activate:second",
      "rollback:third",
      "rollback:second",
      "rollback:first",
    ]);
  });

  it("continues reverse rollback after one callback fails", () => {
    const events: string[] = [];
    const scope = createActivationTransactionScope();
    scope.register(
      () => undefined,
      () => events.push("rollback:first"),
    );
    scope.register(
      () => undefined,
      () => {
        events.push("rollback:second");
        throw new Error("rollback failed");
      },
    );
    scope.register(
      () => undefined,
      () => events.push("rollback:third"),
    );
    scope.activate();

    const errors = scope.rollback();

    expect(events).toEqual(["rollback:third", "rollback:second", "rollback:first"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toEqual(new Error("rollback failed"));
  });

  it("supports immediate cold-start activation and reversible setup failure", () => {
    const events: string[] = [];
    const scope = createActivationTransactionScope({ activateOnRegister: true });
    scope.register(
      () => events.push("activate:first"),
      () => events.push("rollback:first"),
    );
    scope.register(
      () => events.push("activate:second"),
      () => events.push("rollback:second"),
    );

    expect(events).toEqual(["activate:first", "activate:second"]);
    expect(scope.rollback()).toEqual([]);
    expect(events).toEqual([
      "activate:first",
      "activate:second",
      "rollback:second",
      "rollback:first",
    ]);
  });

  it("preserves a cold-start activation error after invoking its rollback", () => {
    const rollback = vi.fn();

    expect(() =>
      runImmediateActivation(() => {
        throw new Error("cold activation failed");
      }, rollback),
    ).toThrow("cold activation failed");
    expect(rollback).toHaveBeenCalledOnce();
  });
});
