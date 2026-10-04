import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { runBenchmark } from "../../scripts/postgis/benchmark";
import { startBenchmarkDatabase } from "../../scripts/postgis/container";
import { collectDiagnostics } from "../../src/postgis/diagnostics";

const enabled = process.env.OPENMAPX_RUN_DATABASE_TESTS === "1";
describe.skipIf(!enabled)("PostGIS production diagnostics entrypoint", () => {
  it("activates diagnostics, excludes password utilities and exports no SQL text", async () => {
    const db = await startBenchmarkDatabase(true);
    try {
      const [sentinel] = await db.container
        .exec(["test", "-f", "/var/run/postgresql/openmapx-password-synced"])
        .then((result) => [result]);
      expect(sentinel.exitCode).toBe(0);
      await db.sql.unsafe("SELECT 42::int");
      const report = await collectDiagnostics(db.sql);
      expect(report.serverVersionNum).toBeGreaterThanOrEqual(180000);
      expect(report.statements.length).toBeGreaterThan(0);
      expect(JSON.stringify(report)).not.toMatch(/SELECT|password|postgres:\/\//);
      const session = await db.sql.reserve();
      try {
        await session.unsafe("SET pg_stat_statements.track='none'");
        await expect(collectDiagnostics(session)).rejects.toThrow("unavailable");
        await session.unsafe("SET pg_stat_statements.track='top'");
      } finally {
        session.release();
      }
      const rows = await db.sql.unsafe(
        "SELECT query FROM pg_stat_statements WHERE query LIKE '%ALTER USER%'",
      );
      expect(rows).toHaveLength(0);
      await db.raw.restart({ t: 10 });
      const ready = await db.container.exec([
        "bash",
        "-c",
        "for i in {1..30}; do pg_isready -h 127.0.0.1 -U postgres -q && test -f /var/run/postgresql/openmapx-password-synced && exit 0; sleep 1; done; exit 1",
      ]);
      expect(ready.exitCode).toBe(0);
      // Docker Desktop can assign a new ephemeral host port after restart.
      const port = (await db.raw.inspect()).NetworkSettings.Ports["5432/tcp"]?.[0]?.HostPort;
      if (!port) throw new Error("Missing restarted database port");
      const uri = new URL(db.container.getConnectionUri());
      uri.port = port;
      const restarted = postgres(uri.toString(), {
        max: 1,
        connect_timeout: 5,
        onnotice: () => {},
      });
      try {
        expect((await collectDiagnostics(restarted)).serverVersionNum).toBeGreaterThanOrEqual(
          180000,
        );
      } finally {
        await restarted.end({ timeout: 2 });
      }
    } finally {
      await db.stop();
    }
  }, 120000);
  it("fails closed on conflicting preloads in an initialized volume", async () => {
    const db = await startBenchmarkDatabase(true);
    try {
      await db.sql.unsafe(
        "ALTER SYSTEM SET shared_preload_libraries='pg_stat_statements,auto_explain'",
      );
      await db.raw.restart({ t: 10 });
      for (let i = 0; i < 30 && (await db.raw.inspect()).State.Running; i++)
        await new Promise((resolve) => setTimeout(resolve, 100));
      const state = (await db.raw.inspect()).State;
      expect(state.Running).toBe(false);
      expect(state.ExitCode).not.toBe(0);
    } finally {
      await db.stop();
    }
  }, 120000);
  it("keeps diagnostics disabled by default and reports the missing extension safely", async () => {
    const db = await startBenchmarkDatabase(false);
    try {
      await expect(collectDiagnostics(db.sql)).rejects.toThrow(
        "PostgreSQL diagnostics unavailable",
      );
    } finally {
      await db.stop();
    }
  }, 120000);
});

describe.skipIf(!enabled)("disposable PostGIS benchmark", () => {
  it("runs all query families without using DATABASE_URL", async () => {
    const previous = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgres://invalid-private-target:secret@127.0.0.1:1/operator";
    try {
      const report = await runBenchmark({ smoke: true });
      expect(report.cases).toHaveLength(10);
      expect(report.fixture.pois).toBe(1000);
      expect(
        report.cases.every(
          (row) => row.correctness === "passed" && row.resources.cpuSampleCount > 0,
        ),
      ).toBe(true);
      expect(JSON.stringify(report)).not.toMatch(
        /invalid-private-target|secret|operator|SELECT|Relation Name/,
      );
    } finally {
      if (previous === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous;
    }
  }, 120000);
  it("rejects cancellation before provisioning", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(runBenchmark({ smoke: true, signal: controller.signal })).rejects.toThrow();
  });
  it("cleans up a container when cancelled during a run", async () => {
    const { execFileSync } = await import("node:child_process");
    const ids = () =>
      execFileSync(
        "docker",
        ["ps", "--format", "{{.ID}}", "--filter", "ancestor=ghcr.io/baosystems/postgis:18-3.6"],
        { encoding: "utf8" },
      )
        .trim()
        .split("\n")
        .filter(Boolean)
        .sort();
    const before = ids();
    const controller = new AbortController();
    const running = runBenchmark({ smoke: true, signal: controller.signal });
    const timeout = setTimeout(() => controller.abort(), 3000);
    try {
      await expect(running).rejects.toThrow();
    } finally {
      clearTimeout(timeout);
    }
    expect(ids()).toEqual(before);
  }, 120000);
});
