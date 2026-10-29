import { describe, expect, it, vi } from "vitest";
import { stopExtensionValkeyFixture } from "./extension-store-valkey-cleanup";

function lifecycle(initialState = "running") {
  const containers = new Map([
    ["owned", initialState],
    ["unrelated", "running"],
  ]);
  const volumes = new Set(["owned", "unrelated"]);
  const events: string[] = [];
  const client = {
    disconnect: () => {
      events.push("disconnect");
    },
  };
  // External container boundary: the installed testcontainers 12.2.0 resolves
  // omitted remove from autoRemove=false. This is a deterministic contract
  // double, not Docker qualification. Assert retained inventory, not just calls.
  const container = {
    stop: vi.fn(
      async (options: { timeout?: number; remove?: boolean; removeVolumes?: boolean } = {}) => {
        events.push("stop");
        containers.set("owned", "exited");
        if (options.remove ?? false) {
          containers.delete("owned");
          if (options.removeVolumes ?? true) volumes.delete("owned");
        }
      },
    ),
  };
  const runtime = {
    container: {
      getById: vi.fn((id: string) => ({
        remove: async (options: { force: boolean; v: boolean }) => {
          events.push(`remove:${id}`);
          if (containers.get(id) === "running" && !options.force) throw new Error("still running");
          containers.delete(id);
          if (options.v) volumes.delete(id);
        },
      })),
    },
  };
  return { containers, volumes, events, client, container, runtime };
}

function expectOnlyUnrelated(state: ReturnType<typeof lifecycle>) {
  expect([...state.containers]).toEqual([["unrelated", "running"]]);
  expect([...state.volumes]).toEqual(["unrelated"]);
}

describe("extension Valkey fixture cleanup lifecycle", () => {
  it("removes the returned container and volumes even though autoRemove is disabled", async () => {
    const state = lifecycle();
    await stopExtensionValkeyFixture({ ...state, createdId: "owned" });
    expectOnlyUnrelated(state);
    expect(state.events).toEqual(["disconnect", "stop"]);
    expect(state.container.stop).toHaveBeenCalledWith({
      timeout: 0,
      remove: true,
      removeVolumes: true,
    });
    expect(state.runtime.container.getById).not.toHaveBeenCalled();
  });

  it.each(["running", "created"])(
    "removes only the captured creation ID if start fails with state %s",
    async (initial) => {
      const state = lifecycle(initial);
      await stopExtensionValkeyFixture({ runtime: state.runtime, createdId: "owned" });
      expectOnlyUnrelated(state);
      expect(state.events).toEqual(["remove:owned"]);
      expect(state.runtime.container.getById).toHaveBeenCalledExactlyOnceWith("owned");
    },
  );

  it("performs no removal when start fails before ownership is established", async () => {
    const state = lifecycle();
    await stopExtensionValkeyFixture({ runtime: state.runtime });
    expect([...state.containers]).toEqual([
      ["owned", "running"],
      ["unrelated", "running"],
    ]);
    expect([...state.volumes]).toEqual(["owned", "unrelated"]);
    expect(state.runtime.container.getById).not.toHaveBeenCalled();
  });

  it("propagates a returned-container cleanup failure instead of claiming successful teardown", async () => {
    const state = lifecycle();
    const failure = new Error("synthetic stop failure");
    state.container.stop.mockRejectedValue(failure);
    await expect(stopExtensionValkeyFixture({ ...state, createdId: "owned" })).rejects.toBe(
      failure,
    );
    expect(state.events).toEqual(["disconnect"]);
    expect(state.containers.has("owned")).toBe(true);
    expect(state.runtime.container.getById).not.toHaveBeenCalled();
  });

  it("propagates failed-start removal failure without broadening ownership", async () => {
    const state = lifecycle("created");
    const failure = new Error("synthetic removal failure");
    state.runtime.container.getById.mockReturnValue({
      remove: async () => {
        throw failure;
      },
    });
    await expect(
      stopExtensionValkeyFixture({ runtime: state.runtime, createdId: "owned" }),
    ).rejects.toBe(failure);
    expect(state.containers.has("owned")).toBe(true);
    expect(state.containers.get("unrelated")).toBe("running");
    expect(state.runtime.container.getById).toHaveBeenCalledExactlyOnceWith("owned");
  });
});
