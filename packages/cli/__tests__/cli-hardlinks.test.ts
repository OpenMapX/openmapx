import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generationLinkOperationKey } from "@openmapx/core/build-artifacts";
import { services } from "@openmapx/core/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { currentHostLease } from "../src/lib/host-effect";

// The lease a host effect such as `control rollback` holds while it runs.
vi.mock("../src/lib/host-effect", async (original) => ({
  ...(await original<typeof import("../src/lib/host-effect")>()),
  currentHostLease: vi.fn(() => undefined),
}));

import {
  applyGeneratedHardlinks,
  applyGeneratedHardlinksBeforeStart,
  DATA_ROOT_MODE,
  DataManagerBusyError,
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
  writeFileSync(planPath(), JSON.stringify(plan), { encoding: "utf-8", mode: 0o600 });
}

function writeOsm(): void {
  mkdirSync(join(dataRoot(), "osm"), { recursive: true });
  writeFileSync(join(dataRoot(), "osm", "planet.osm.pbf"), "PBF");
}

/** A data-manager that answers `/status` and records each `/link` request. */
async function fakeDataManager(
  options: { linkRefusal?: string; linkStatus?: number; onStatus?: () => void } = {},
): Promise<{
  url: string;
  requests: Array<{ revisionId: unknown; plan: unknown; prune: unknown }>;
  bodies: Array<Record<string, unknown>>;
  server: Server;
}> {
  const requests: Array<{ revisionId: unknown; plan: unknown; prune: unknown }> = [];
  const bodies: Array<Record<string, unknown>> = [];
  const server = createServer((req, res) => {
    if (req.url === "/status") {
      options.onStatus?.();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, uptime: 1, dataDir: "/data" }));
      return;
    }
    if (req.url === "/link" && req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(Buffer.from(c)));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
        requests.push({ revisionId: body.revisionId, plan: body.plan, prune: body.prune });
        bodies.push(body);
        if (options.linkRefusal) {
          res.writeHead(options.linkStatus ?? 503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: options.linkRefusal }));
          return;
        }
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
  return { url: `http://127.0.0.1:${port}`, requests, bodies, server };
}

const REVISION = `cfg1_${"r".repeat(43)}`;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "openmapx-cli-hardlinks-"));
  writeFileSync(join(tmp, "pnpm-workspace.yaml"), "packages: []\n");
  mkdirSync(join(tmp, "services"), { recursive: true });
  mkdirSync(dataRoot(), { recursive: true });
  // The applied generation and the `current` pointer to it.
  const infra = join(tmp, "infra", "docker");
  // The configuration's directories are private, as the configuration writer requires.
  mkdirSync(join(infra, services.CONFIGURATION_GENERATIONS), { recursive: true, mode: 0o700 });
  mkdirSync(join(infra, services.CONFIGURATION_GENERATIONS, REVISION), { mode: 0o700 });
  symlinkSync(`generations/${REVISION}`, join(infra, services.CURRENT_CONFIGURATION));
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
      expect(dataManager.requests).toEqual([
        { revisionId: REVISION, plan: [OSM_FOR_VALHALLA], prune: true },
      ]);
      // data-manager links; the CLI made nothing in the data directory.
      expect(existsSync(join(dataRoot(), "valhalla"))).toBe(false);
    } finally {
      await new Promise<void>((resolve) => dataManager.server.close(() => resolve()));
    }
  });

  it("sends the plan of the generation it names, even when another generation is applied meanwhile", async () => {
    writeOsm();
    writePlan([OSM_FOR_VALHALLA]);
    const infra = join(tmp, "infra", "docker"),
      next = `cfg1_${"n".repeat(43)}`;
    mkdirSync(join(infra, services.CONFIGURATION_GENERATIONS, next), { mode: 0o700 });
    writeFileSync(
      join(
        infra,
        services.CONFIGURATION_GENERATIONS,
        next,
        "docker-compose.generated.hardlinks.json",
      ),
      JSON.stringify([]),
      { mode: 0o600 },
    );
    // Another generation becomes current while the CLI waits for data-manager.
    const dataManager = await fakeDataManager({
      onStatus: () => {
        rmSync(join(infra, services.CURRENT_CONFIGURATION));
        symlinkSync(`generations/${next}`, join(infra, services.CURRENT_CONFIGURATION));
      },
    });
    try {
      await applyGeneratedHardlinks({
        rootDir: tmp,
        requirePlan: true,
        prune: true,
        dataManagerUrl: dataManager.url,
      });
      expect(dataManager.requests).toEqual([
        { revisionId: REVISION, plan: [OSM_FOR_VALHALLA], prune: true },
      ]);
    } finally {
      await new Promise<void>((resolve) => dataManager.server.close(() => resolve()));
    }
  });

  it("sends the plan under the lease a host effect holds, keyed by that operation", async () => {
    writeOsm();
    writePlan([OSM_FOR_VALHALLA]);
    const owner = {
      executor: "host-cli" as const,
      principal: "host-cli" as const,
      executionId: "11111111-1111-4111-8111-111111111111",
      operationKey: `opk1_t1_${(Date.now() + 600_000).toString(16).padStart(14, "0")}_${"A".repeat(22)}`,
      operationFingerprint: "a".repeat(64),
      deadlineAt: Date.now() + 600_000,
      fingerprint: "b".repeat(64),
    };
    const leaseId = "22222222-2222-4222-8222-222222222222";
    vi.mocked(currentHostLease).mockReturnValue({ leaseId, owner });
    const dataManager = await fakeDataManager();
    try {
      await applyGeneratedHardlinks({
        rootDir: tmp,
        requirePlan: true,
        prune: true,
        dataManagerUrl: dataManager.url,
      });
      // Data-manager admits it under this lease instead of leasing itself,
      // which the rollback's own lease on every service would refuse.
      expect(dataManager.bodies[0]).toMatchObject({
        leaseId,
        operationKey: generationLinkOperationKey(owner, REVISION),
        requestedDeadlineAt: owner.deadlineAt,
      });
    } finally {
      vi.mocked(currentHostLease).mockReturnValue(undefined);
      await new Promise<void>((resolve) => dataManager.server.close(() => resolve()));
    }
  });

  it("sends no lease and a fresh key without a held lease", async () => {
    writeOsm();
    writePlan([OSM_FOR_VALHALLA]);
    const dataManager = await fakeDataManager();
    try {
      for (let n = 0; n < 2; n++)
        await applyGeneratedHardlinks({
          rootDir: tmp,
          requirePlan: true,
          prune: true,
          dataManagerUrl: dataManager.url,
        });
      expect(dataManager.bodies.map((body) => body.leaseId)).toEqual([undefined, undefined]);
      expect(new Set(dataManager.bodies.map((body) => body.operationKey)).size).toBe(2);
    } finally {
      await new Promise<void>((resolve) => dataManager.server.close(() => resolve()));
    }
  });

  it.each([
    ["an empty plan", []],
    ["a plan whose producers hold no data", [OSM_FOR_VALHALLA]],
  ])("does not call /link for %s, even when data-manager is reachable", async (_name, plan) => {
    writePlan(plan);
    const dataManager = await fakeDataManager();
    try {
      const result = await applyGeneratedHardlinks({
        rootDir: tmp,
        requirePlan: true,
        prune: true,
        dataManagerUrl: dataManager.url,
      });

      expect(result).toMatchObject({
        applied: false,
        entries: plan.length,
        linked: 0,
        skipped: 0,
        pruned: 0,
        via: "none",
      });
      expect(dataManager.requests).toEqual([]);
    } finally {
      await new Promise<void>((resolve) => dataManager.server.close(() => resolve()));
    }
  });

  it("reports data-manager answering unavailable as unavailable, not busy, and asks once", async () => {
    writeOsm();
    writePlan([OSM_FOR_VALHALLA]);
    const dataManager = await fakeDataManager({
      linkRefusal: "Hardlink plan not applied: the agent did not answer",
    });
    try {
      await expect(
        applyGeneratedHardlinks({
          rootDir: tmp,
          requirePlan: true,
          prune: true,
          dataManagerUrl: dataManager.url,
        }),
      ).rejects.toBeInstanceOf(DataManagerUnavailableError);
      expect(dataManager.requests).toHaveLength(1);
    } finally {
      await new Promise<void>((resolve) => dataManager.server.close(() => resolve()));
    }
  });

  it("reports a data-manager busy with another data job, and a start goes ahead", async () => {
    writeOsm();
    writePlan([OSM_FOR_VALHALLA]);
    const dataManager = await fakeDataManager({
      linkRefusal: "configuration_maintenance_busy",
      linkStatus: 409,
    });
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        applyGeneratedHardlinks({
          rootDir: tmp,
          requirePlan: true,
          prune: true,
          dataManagerUrl: dataManager.url,
        }),
      ).rejects.toBeInstanceOf(DataManagerBusyError);
      await expect(
        applyGeneratedHardlinksBeforeStart({ rootDir: tmp, dataManagerUrl: dataManager.url }),
      ).resolves.toBeUndefined();
      expect(warn.mock.calls.flat().join("\n")).toMatch(/another data job.*data link/);
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
