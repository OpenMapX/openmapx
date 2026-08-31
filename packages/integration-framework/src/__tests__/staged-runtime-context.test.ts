import { describe, expect, it, vi } from "vitest";
import { createStagedRuntimeContext } from "../staged-runtime-context";

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
});
