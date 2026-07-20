import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CANDIDATE_PROXY_DIRNAME,
  createCandidateManifest,
} from "../../src/jobs/transitous/candidate.js";
import { buildJobContext } from "../../src/jobs/transitous/pipeline.js";
import { rollbackProxyTransaction, run } from "../../src/jobs/transitous/proxy-transaction.js";
import { StateStore } from "../../src/state.js";

let tmp: string | undefined;
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

function setup(candidateVars: Record<string, unknown>, currentVars: Record<string, unknown>) {
  tmp = mkdtempSync(join(tmpdir(), "openmapx-proxy-transaction-"));
  const staging = join(tmp, "motis", "staging");
  mkdirSync(join(staging, CANDIDATE_PROXY_DIRNAME, "conf"), { recursive: true });
  writeFileSync(join(staging, "config.yml"), "timetable:\n  datasets:\n    demo: {}\n");
  writeFileSync(join(staging, "license.json"), "{}\n");
  writeFileSync(join(staging, "demo.gtfs.zip"), "gtfs");
  writeFileSync(join(staging, CANDIDATE_PROXY_DIRNAME, "conf", "default.conf"), "candidate\n");
  writeFileSync(
    join(staging, CANDIDATE_PROXY_DIRNAME, "feed-proxy-vars.json"),
    `${JSON.stringify(candidateVars)}\n`,
  );
  createCandidateManifest(staging, "epoch-1", "2026-01-01T00:00:00Z");
  const active = join(tmp, "motis-feed-proxy");
  mkdirSync(join(active, "conf"), { recursive: true });
  writeFileSync(join(active, "conf", "default.conf"), "old bytes\n");
  writeFileSync(join(active, "feed-proxy-vars.json"), `${JSON.stringify(currentVars)}\n`);
  return { staging, active };
}

function ctx(dataDir: string, failAt?: "test" | "reload") {
  return buildJobContext({
    dataDir,
    store: new StateStore(dataDir),
    runner: async (_command, args) => {
      if (failAt === "test" && args.includes("-t")) throw new Error("invalid nginx");
      if (failAt === "reload" && args.includes("reload")) throw new Error("reload failed");
    },
    now: () => "2026-01-01T00:00:00Z",
  });
}

function dataDir(): string {
  if (!tmp) throw new Error("fixture not initialized");
  return tmp;
}

describe("feed proxy transaction", () => {
  it("serves an old+candidate union and restores previous bytes on rollback", async () => {
    const old = { old: { url: "https://old.example/feed" } };
    const candidate = { next: { url: "https://next.example/feed" } };
    const fx = setup(candidate, old);
    const context = ctx(dataDir());
    expect((await run(context)).status).toBe("ok");
    expect(readFileSync(join(fx.active, "feed-proxy-vars.json"), "utf-8")).toContain('"old"');
    expect(readFileSync(join(fx.active, "feed-proxy-vars.json"), "utf-8")).toContain('"next"');
    await rollbackProxyTransaction(context);
    expect(readFileSync(join(fx.active, "conf", "default.conf"), "utf-8")).toBe("old bytes\n");
    expect(JSON.parse(readFileSync(join(fx.active, "feed-proxy-vars.json"), "utf-8"))).toEqual(old);
  });

  it("re-links the written config into the container-mounted copy so nginx sees it", async () => {
    const fx = setup({ "de-x": { url: "https://x.example/gbfs.json", gbfs: true } }, {});
    if (!tmp) throw new Error("fixture not initialized");
    // A hardlink plan like the compose renderer emits: producer `conf/` →
    // consumer `motis-feed-proxy-config/` (the dir the container mounts).
    const infra = join(tmp, "repo", "infra", "docker");
    mkdirSync(infra, { recursive: true });
    writeFileSync(
      join(infra, "docker-compose.generated.hardlinks.json"),
      JSON.stringify([
        {
          source: "data/motis-feed-proxy/conf",
          target: "data/motis-feed-proxy/motis-feed-proxy-config",
          consumerService: "motis-feed-proxy",
          dataType: "motis-feed-proxy-config",
        },
      ]),
    );
    const context = buildJobContext({
      dataDir: tmp,
      repoRoot: join(tmp, "repo"),
      store: new StateStore(tmp),
      runner: async () => {},
      now: () => "2026-01-01T00:00:00Z",
    });
    expect((await run(context)).status).toBe("ok");

    const producerPath = join(fx.active, "conf", "default.conf");
    const mountedPath = join(tmp, "motis-feed-proxy", "motis-feed-proxy-config", "default.conf");
    // The container-mounted copy matches the freshly written producer config…
    expect(readFileSync(mountedPath, "utf-8")).toBe(readFileSync(producerPath, "utf-8"));
    // …and is a hardlink to it (same inode), so future in-place writes propagate.
    expect(statSync(mountedPath).ino).toBe(statSync(producerPath).ino);
  });

  it("restores exact previous files when nginx validation fails", async () => {
    const fx = setup({ next: { url: "https://next.example/feed" } }, {});
    const result = await run(ctx(dataDir(), "test"));
    expect(result.status).toBe("error");
    expect(readFileSync(join(fx.active, "conf", "default.conf"), "utf-8")).toBe("old bytes\n");
  });

  it("takes the candidate value when a route's upstream changed (rotated key/URL)", async () => {
    // The primary keeps the same /feed/<id> location, now pointing at the
    // refreshed upstream for the same logical feed — mirroring upstream
    // Transitous. Rollback still restores the old bytes if the candidate is bad.
    const fx = setup(
      { same: { url: "https://new.example/feed" } },
      { same: { url: "https://old.example/feed" } },
    );
    const context = ctx(dataDir());
    expect((await run(context)).status).toBe("ok");
    const vars = JSON.parse(readFileSync(join(fx.active, "feed-proxy-vars.json"), "utf-8"));
    expect(vars.same.url).toBe("https://new.example/feed");
    await rollbackProxyTransaction(context);
    expect(JSON.parse(readFileSync(join(fx.active, "feed-proxy-vars.json"), "utf-8"))).toEqual({
      same: { url: "https://old.example/feed" },
    });
  });
});
