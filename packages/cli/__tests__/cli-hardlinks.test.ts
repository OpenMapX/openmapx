import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { services } from "@openmapx/core/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyGeneratedHardlinks,
  applyGeneratedHardlinksBeforeStart,
  DATA_ROOT_MODE,
  DataManagerUnavailableError,
} from "../src/lib/hardlinks";

let tmp: string;
// Nothing listens there, so the reachability probe fails fast.
const UNREACHABLE = { dataManagerUrl: "http://127.0.0.1:1", reachabilityTimeoutMs: 250 };

/** The applied generation's hardlink plan. */
function planPath(): string {
  return join(
    tmp,
    "infra",
    "docker",
    services.CURRENT_CONFIGURATION,
    "docker-compose.generated.hardlinks.json",
  );
}

function dataRoot(): string {
  return join(tmp, "infra", "docker", "data");
}

const OSM_FOR_VALHALLA = {
  source: "data/osm",
  target: "data/valhalla/osm-pbf",
  consumerService: "valhalla",
  dataType: "osm-pbf",
};

function writePlan(plan: unknown[]): void {
  writeFileSync(planPath(), JSON.stringify(plan), "utf-8");
}

function writeOsm(): void {
  mkdirSync(join(dataRoot(), "osm"), { recursive: true });
  writeFileSync(join(dataRoot(), "osm", "planet.osm.pbf"), "PBF");
}

/** A data-manager that answers `/status` and records each `/link` request. */
async function fakeDataManager(): Promise<{
  url: string;
  requests: Array<{ plan: unknown; prune: unknown }>;
  server: Server;
}> {
  const requests: Array<{ plan: unknown; prune: unknown }> = [];
  const server = createServer((req, res) => {
    if (req.url === "/status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, uptime: 1, dataDir: "/data" }));
      return;
    }
    if (req.url === "/link" && req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(Buffer.from(c)));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
        requests.push({ plan: body.plan, prune: body.prune });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, linked: 7, skipped: 2, pruned: 1 }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, requests, server };
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "openmapx-cli-hardlinks-"));
  writeFileSync(join(tmp, "pnpm-workspace.yaml"), "packages: []\n");
  mkdirSync(join(tmp, "services"), { recursive: true });
  mkdirSync(dataRoot(), { recursive: true });
  mkdirSync(join(tmp, "infra", "docker", services.CURRENT_CONFIGURATION), { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(tmp, { recursive: true, force: true });
});

describe("applyGeneratedHardlinks", () => {
  it("can no-op when the plan is missing", async () => {
    const result = await applyGeneratedHardlinks({
      rootDir: tmp,
      requirePlan: false,
      ...UNREACHABLE,
    });
    expect(result.applied).toBe(false);
    expect(result.linked).toBe(0);
    expect(result.pruned).toBe(0);
    expect(result.via).toBe("none");
  });

  it("sends the applied generation's plan to data-manager", async () => {
    writeOsm();
    writePlan([OSM_FOR_VALHALLA]);
    const dataManager = await fakeDataManager();
    try {
      const result = await applyGeneratedHardlinks({
        rootDir: tmp,
        requirePlan: true,
        prune: true,
        dataManagerUrl: dataManager.url,
      });

      expect(result).toMatchObject({
        applied: true,
        entries: 1,
        via: "data-manager",
        linked: 7,
        skipped: 2,
        pruned: 1,
      });
      expect(dataManager.requests).toEqual([{ plan: [OSM_FOR_VALHALLA], prune: true }]);
      // data-manager links; the CLI made nothing in the data directory.
      expect(existsSync(join(dataRoot(), "valhalla"))).toBe(false);
    } finally {
      await new Promise<void>((resolve) => dataManager.server.close(() => resolve()));
    }
  });

  it("refuses without linking when data-manager is unreachable and the plan has work", async () => {
    writeOsm();
    writePlan([OSM_FOR_VALHALLA]);

    const attempt = applyGeneratedHardlinks({
      rootDir: tmp,
      requirePlan: true,
      prune: true,
      ...UNREACHABLE,
    });

    await expect(attempt).rejects.toBeInstanceOf(DataManagerUnavailableError);
    await expect(attempt).rejects.toThrow(
      /not applied: data-manager applies it inside its container.*not reachable at http:\/\/127\.0\.0\.1:1\. Start data-manager.*then run pnpm openmapx data link/,
    );
    expect(existsSync(join(dataRoot(), "valhalla"))).toBe(false);
    expect(readdirSync(dataRoot()).sort()).toEqual(["osm"]);
  });

  it("refuses while an earlier apply's sentinel could need pruning", async () => {
    // The producer is gone, but the sentinel records links to remove.
    writePlan([OSM_FOR_VALHALLA]);
    mkdirSync(join(dataRoot(), ".hardlinks-sentinel"), { recursive: true });
    writeFileSync(
      join(dataRoot(), ".hardlinks-sentinel", "valhalla__osm-pbf.json"),
      JSON.stringify({ linkedPaths: ["planet.osm.pbf"] }),
    );

    await expect(
      applyGeneratedHardlinks({ rootDir: tmp, requirePlan: true, prune: true, ...UNREACHABLE }),
    ).rejects.toBeInstanceOf(DataManagerUnavailableError);
  });

  it("has nothing to apply before any data exists, without data-manager", async () => {
    writePlan([OSM_FOR_VALHALLA]);

    const result = await applyGeneratedHardlinks({
      rootDir: tmp,
      requirePlan: true,
      prune: true,
      ...UNREACHABLE,
    });

    expect(result).toMatchObject({ applied: false, entries: 1, via: "none", linked: 0 });
    expect(readdirSync(dataRoot())).toEqual([]);
  });

  it("creates the data root with an explicit mode even with an empty plan", async () => {
    rmSync(dataRoot(), { recursive: true, force: true });
    writePlan([]);
    // Its mode is explicit, not the umask's.
    const umask = process.umask(0o002);
    try {
      const result = await applyGeneratedHardlinks({
        rootDir: tmp,
        requirePlan: true,
        prune: true,
        ...UNREACHABLE,
      });
      expect(result.via).toBe("none");
    } finally {
      process.umask(umask);
    }
    expect(statSync(dataRoot()).isDirectory()).toBe(true);
    expect(statSync(dataRoot()).mode & 0o777).toBe(DATA_ROOT_MODE);
  });
});

describe("applyGeneratedHardlinksBeforeStart", () => {
  it("warns and lets the start go ahead when data-manager is unreachable", async () => {
    writeOsm();
    writePlan([OSM_FOR_VALHALLA]);
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const ok = vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(
      applyGeneratedHardlinksBeforeStart({ rootDir: tmp, ...UNREACHABLE }),
    ).resolves.toBeUndefined();

    expect(ok).not.toHaveBeenCalled();
    const output = warn.mock.calls.flat().join("\n");
    expect(output).toMatch(/hardlink plan \(1 entry\) was not applied/);
    expect(output).toMatch(/pnpm openmapx data link/);
    expect(existsSync(join(dataRoot(), "valhalla"))).toBe(false);
  });

  it("still fails on other errors, such as a missing plan", async () => {
    await expect(
      applyGeneratedHardlinksBeforeStart({ rootDir: tmp, ...UNREACHABLE }),
    ).rejects.toThrow(/Hardlink plan not found/);
  });
});

it("leaves applying the plan to data-manager: the CLI has no plan linker of its own", () => {
  const sourceRoot = new URL("../src/", import.meta.url).pathname;
  const files = readdirSync(sourceRoot, { recursive: true, encoding: "utf-8" }).filter((file) =>
    file.endsWith(".ts"),
  );
  expect(files.length).toBeGreaterThan(0);
  const linkers = files.filter((file) =>
    /\bapplyHardlinkPlan\b/.test(readFileSync(join(sourceRoot, file), "utf-8")),
  );
  expect(linkers).toEqual([]);
  expect(readFileSync(join(sourceRoot, "lib", "hardlinks.ts"), "utf-8")).not.toMatch(/linkSync/);
});
