import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

function run(flags: Record<string, string> = {}, preloads = "", lookupFails = false) {
  const root = mkdtempSync(join(tmpdir(), "postgis-diagnostics-"));
  try {
    const stub = `#!${process.execPath}
const fs = require('node:fs');
const name = require('node:path').basename(process.argv[1]);
if (name === 'docker-entrypoint.sh') {
  fs.writeFileSync(process.env.ARGS, JSON.stringify(process.argv.slice(2)));
} else if (name === 'postgres' || name === 'gosu') {
  if (process.env.LOOKUP_FAIL === '1') process.exit(1);
  console.log(process.env.PRELOADS);
} else if (name === 'cat') console.log(process.env.FIXTURE_LIMIT || 'max');
else if (name === 'awk') console.log('1024000');
`;
    for (const name of [
      "docker-entrypoint.sh",
      "postgres",
      "gosu",
      "pg_isready",
      "psql",
      "rm",
      "touch",
      "cat",
      "awk",
    ])
      writeFileSync(join(root, name), stub, { mode: 0o755 });
    const result = spawnSync(
      resolve("services/postgis/scripts/sync-password.sh"),
      ["postgres", "-c", "max_wal_size=4GB"],
      {
        encoding: "utf8",
        env: {
          ARGS: join(root, "args"),
          PRELOADS: preloads,
          LOOKUP_FAIL: lookupFails ? "1" : "0",
          ...flags,
          PATH: `${root}:/usr/bin:/bin`,
        },
      },
    );
    return {
      status: result.status,
      stderr: result.stderr,
      args: result.status === 0 ? JSON.parse(readFileSync(join(root, "args"), "utf8")) : [],
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
describe("PostGIS diagnostics opt-in", () => {
  it("leaves the default postgres command unchanged", () => {
    expect(run().args).toEqual(["postgres", "-c", "max_wal_size=4GB"]);
  });
  it("ignores hostile inherited executable search paths", () => {
    const hostile = mkdtempSync(join(tmpdir(), "postgis-hostile-path-"));
    try {
      for (const name of ["bash", "python3", "seq"])
        writeFileSync(join(hostile, name), "#!/bin/sh\nexit 86\n", { mode: 0o755 });
      vi.stubEnv("PATH", `${hostile}:${process.env.PATH}`);
      const result = run({ POSTGIS_DIAGNOSTICS: "true" }, "auto_explain");
      expect(result.status).toBe(0);
      expect(result.args).toContain("shared_preload_libraries=auto_explain,pg_stat_statements");
    } finally {
      vi.unstubAllEnvs();
      rmSync(hostile, { recursive: true, force: true });
    }
  });
  it("merges preloads and keeps planning disabled", () => {
    const result = run({ POSTGIS_DIAGNOSTICS: "true" }, "auto_explain, pg_prewarm");
    expect(result.status).toBe(0);
    expect(result.args).toContain(
      "shared_preload_libraries=auto_explain,pg_prewarm,pg_stat_statements",
    );
    expect(result.args).toContain("pg_stat_statements.track_planning=off");
  });
  it("does not duplicate pg_stat_statements", () => {
    expect(run({ POSTGIS_DIAGNOSTICS: "true" }, "pg_stat_statements,auto_explain").args).toContain(
      "shared_preload_libraries=pg_stat_statements,auto_explain",
    );
  });
  it("preserves memory-derived arguments with diagnostics enabled", () => {
    for (const enabled of ["false", "true"]) {
      const result = run({ FIXTURE_LIMIT: "536870912", POSTGIS_DIAGNOSTICS: enabled });
      expect(result.status).toBe(0);
      expect(result.args).toContain("shared_buffers=128MB");
      expect(result.args).toContain("effective_cache_size=384MB");
    }
  });
  it("enables IO timing independently", () => {
    expect(run({ POSTGIS_TRACK_IO_TIMING: "true" }).args).toEqual([
      "postgres",
      "-c",
      "max_wal_size=4GB",
      "-c",
      "track_io_timing=on",
    ]);
  });
  it("rejects invalid flags and unresolved configuration without exposing its value", () => {
    expect(run({ POSTGIS_DIAGNOSTICS: "yes" }).status).not.toBe(0);
    expect(run({ POSTGIS_TRACK_IO_TIMING: "yes" }).status).not.toBe(0);
    expect(run({ POSTGIS_DIAGNOSTICS: "true" }, "", true).status).not.toBe(0);
    expect(run({ POSTGIS_DIAGNOSTICS: "true" }, "auto_explain pg_stat_statements").status).not.toBe(
      0,
    );
    const malformed = run({ POSTGIS_DIAGNOSTICS: "true" }, "unknown secret!");
    expect(malformed.status).not.toBe(0);
    expect(malformed.stderr).not.toContain("secret");
  });
});
