import type { IntegrationContext } from "@openmapx/integration-framework";
import { describe, expect, it } from "vitest";
import {
  beginRuntimeStaging as beginEvRuntimeStaging,
  commitRuntimeStaging as commitEvRuntimeStaging,
  getRuntimeContext as getEvRuntimeContext,
  initRuntime as initEvRuntime,
  rollbackRuntimeStaging as rollbackEvRuntimeStaging,
  stageRuntimeCommit as stageEvRuntimeCommit,
} from "./ev-charging/runtime.js";
import {
  beginRuntimeStaging as beginParkingRuntimeStaging,
  commitRuntimeStaging as commitParkingRuntimeStaging,
  getRuntimeContext as getParkingRuntimeContext,
  initRuntime as initParkingRuntime,
  rollbackRuntimeStaging as rollbackParkingRuntimeStaging,
  stageRuntimeCommit as stageParkingRuntimeCommit,
} from "./parking/runtime.js";

function context(id: string): IntegrationContext {
  return { id } as IntegrationContext;
}

const runtimes = [
  {
    name: "parking",
    begin: beginParkingRuntimeStaging,
    commit: commitParkingRuntimeStaging,
    get: getParkingRuntimeContext,
    init: initParkingRuntime,
    rollback: rollbackParkingRuntimeStaging,
    stageCommit: stageParkingRuntimeCommit,
  },
  {
    name: "EV charging",
    begin: beginEvRuntimeStaging,
    commit: commitEvRuntimeStaging,
    get: getEvRuntimeContext,
    init: initEvRuntime,
    rollback: rollbackEvRuntimeStaging,
    stageCommit: stageEvRuntimeCommit,
  },
];

describe.each(runtimes)("$name runtime context generation staging", (runtime) => {
  it("keeps the active context until commit", () => {
    runtime.init(context("old"));

    runtime.begin();
    runtime.init(context("new"));

    expect(runtime.get().id).toBe("old");

    runtime.commit();
    expect(runtime.get().id).toBe("new");
  });

  it("preserves the active context on rollback", () => {
    runtime.init(context("old"));

    runtime.begin();
    runtime.init(context("failed-generation"));
    runtime.rollback();

    expect(runtime.get().id).toBe("old");
  });

  it("applies staged global configuration only on commit", () => {
    const applied: string[] = [];

    runtime.begin();
    runtime.stageCommit(() => applied.push("new-generation"));
    expect(applied).toEqual([]);

    runtime.commit();
    expect(applied).toEqual(["new-generation"]);
  });

  it("discards staged global configuration on rollback", () => {
    const applied: string[] = [];

    runtime.begin();
    runtime.stageCommit(() => applied.push("failed-generation"));
    runtime.rollback();

    expect(applied).toEqual([]);
  });

  it("restores committed runtime state when a later activation fails", () => {
    const applied: string[] = [];
    runtime.init(context("old"));
    runtime.begin();
    runtime.init(context("new"));
    runtime.stageCommit(
      () => applied.push("new-generation"),
      () => applied.push("old-generation"),
    );

    runtime.commit();
    expect(runtime.get().id).toBe("new");
    runtime.rollback();

    expect(runtime.get().id).toBe("old");
    expect(applied).toEqual(["new-generation", "old-generation"]);
  });
});
