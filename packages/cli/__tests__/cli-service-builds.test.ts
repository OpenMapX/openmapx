import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildServices,
  planServiceBuilds,
  resolveDataBuildServiceId,
  type ServiceBuildHandler,
} from "../src/lib/service-builds";

let tmp: string;

function writeManifest(slug: string, body: Record<string, unknown>) {
  const dir = join(tmp, "services", slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "service.json"), JSON.stringify(body), "utf-8");
}

const baseManifest = {
  name: "Test",
  version: "1.0.0",
  quality: "built-in",
  container: { image: "t/x", tag: "latest", expose: [80] },
};

beforeEach(() => {
  delete process.env.OPENMAPX_REGION;
  delete process.env.MOTIS_REGION;
  delete process.env.OSRM_REGION;
  delete process.env.OTP_REGION;
  delete process.env.OVERPASS_REGION;
  delete process.env.PELIAS_REGION;
  delete process.env.TILESERVER_REGION;
  tmp = mkdtempSync(join(tmpdir(), "openmapx-service-builds-"));
  writeFileSync(join(tmp, "pnpm-workspace.yaml"), "packages: []\n");
  mkdirSync(join(tmp, "services"), { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("planServiceBuilds", () => {
  it("orders build-all plans by the canonical service build sequence", async () => {
    writeManifest("tileserver", {
      ...baseManifest,
      id: "tileserver",
      buildCommand: "openmapx services build tileserver",
    });
    writeManifest("motis", {
      ...baseManifest,
      id: "motis",
      buildCommand: "openmapx services build motis",
    });
    writeManifest("osrm", {
      ...baseManifest,
      id: "osrm",
      buildCommand: "openmapx services build osrm",
    });

    const plan = await planServiceBuilds({ rootDir: tmp, mode: "all" });

    expect(plan.map((item) => item.id)).toEqual(["osrm", "motis", "tileserver"]);
  });

  it("preserves explicit build order while deduplicating repeated ids", async () => {
    writeManifest("tileserver", {
      ...baseManifest,
      id: "tileserver",
      buildCommand: "openmapx services build tileserver",
    });
    writeManifest("osrm", {
      ...baseManifest,
      id: "osrm",
      buildCommand: "openmapx services build osrm",
    });

    const plan = await planServiceBuilds({
      rootDir: tmp,
      mode: "explicit",
      serviceIds: ["tileserver", "osrm", "tileserver"],
    });

    expect(plan.map((item) => item.id)).toEqual(["tileserver", "osrm"]);
  });

  it("rejects manifests without a matching buildCommand", async () => {
    writeManifest("alpha", { ...baseManifest, id: "alpha" });

    await expect(
      planServiceBuilds({ rootDir: tmp, mode: "explicit", serviceIds: ["alpha"] }),
    ).rejects.toThrow(/does not declare a buildCommand/);

    writeManifest("beta", {
      ...baseManifest,
      id: "beta",
      buildCommand: "openmapx data build beta",
    });

    await expect(
      planServiceBuilds({ rootDir: tmp, mode: "explicit", serviceIds: ["beta"] }),
    ).rejects.toThrow(/unsupported buildCommand/);
  });
});

describe("buildServices", () => {
  it("runs explicit build handlers and can continue past failures", async () => {
    const calls: string[] = [];
    const handlers: Record<string, ServiceBuildHandler> = {
      async alpha() {
        calls.push("alpha");
        return { summary: "Built alpha" };
      },
      async beta() {
        calls.push("beta");
        throw new Error("beta broke");
      },
      async gamma() {
        calls.push("gamma");
        return { summary: "Built gamma" };
      },
    };

    for (const id of Object.keys(handlers)) {
      writeManifest(id, {
        ...baseManifest,
        id,
        buildCommand: `openmapx services build ${id}`,
      });
    }

    const result = await buildServices({
      rootDir: tmp,
      mode: "explicit",
      serviceIds: ["alpha", "beta", "gamma"],
      continueOnError: true,
      handlers,
    });

    expect(calls).toEqual(["alpha", "beta", "gamma"]);
    expect(result.plannedIds).toEqual(["alpha", "beta", "gamma"]);
    expect(result.completedIds).toEqual(["alpha", "gamma"]);
    expect(result.failures).toEqual([{ id: "beta", message: "beta broke" }]);
  });

  it("uses service-specific region env defaults when no --region is passed", async () => {
    process.env.OSRM_REGION = "europe/germany";
    process.env.OTP_REGION = "europe/france";

    const seen: Array<{ id: string; region?: string }> = [];
    const handlers: Record<string, ServiceBuildHandler> = {
      async osrm({ region }) {
        seen.push({ id: "osrm", region });
        return { summary: "Built osrm" };
      },
      async otp({ region }) {
        seen.push({ id: "otp", region });
        return { summary: "Built otp" };
      },
    };

    for (const id of Object.keys(handlers)) {
      writeManifest(id, {
        ...baseManifest,
        id,
        buildCommand: `openmapx services build ${id}`,
      });
    }

    await buildServices({
      rootDir: tmp,
      mode: "explicit",
      serviceIds: ["osrm", "otp"],
      handlers,
    });

    expect(seen).toEqual([
      { id: "osrm", region: "europe/germany" },
      { id: "otp", region: "europe/france" },
    ]);
  });

  it("prefers the explicit --region value over env defaults", async () => {
    process.env.OSRM_REGION = "europe/germany";

    let seenRegion: string | undefined;
    writeManifest("osrm", {
      ...baseManifest,
      id: "osrm",
      buildCommand: "openmapx services build osrm",
    });

    await buildServices({
      rootDir: tmp,
      mode: "explicit",
      serviceIds: ["osrm"],
      region: "planet",
      handlers: {
        async osrm({ region }) {
          seenRegion = region;
          return { summary: "Built osrm" };
        },
      },
    });

    expect(seenRegion).toBe("planet");
  });
});

describe("resolveDataBuildServiceId", () => {
  it("accepts canonical service ids only", () => {
    expect(resolveDataBuildServiceId("tiles")).toBeUndefined();
    expect(resolveDataBuildServiceId("tileserver")).toBe("tileserver");
    expect(resolveDataBuildServiceId("osrm")).toBe("osrm");
    expect(resolveDataBuildServiceId("unknown")).toBeUndefined();
  });
});
