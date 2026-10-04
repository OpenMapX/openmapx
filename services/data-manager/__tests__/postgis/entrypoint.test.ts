import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const root = resolve(__dirname, "../../../..");
const source = readFileSync(join(root, "services/postgis/scripts/sync-password.sh"), "utf8");
const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function run(flag: string, failExtension = false, args = ["postgres"]) {
  const dir = mkdtempSync(join(tmpdir(), "postgis-entrypoint-"));
  directories.push(dir);
  const log = join(dir, "log");
  writeFileSync(
    join(dir, "docker-entrypoint.sh"),
    '#!/bin/bash\nprintf "start:%s\\n" "$*" >> "$HARNESS_LOG"\nsleep 0.1\n',
    { mode: 0o700 },
  );
  writeFileSync(join(dir, "pg_isready"), "#!/bin/bash\nexit 0\n", { mode: 0o700 });
  writeFileSync(
    join(dir, "psql"),
    '#!/bin/bash\nprintf "psql:%s\\n" "$*" >> "$HARNESS_LOG"\nif [[ "$*" == *"CREATE EXTENSION"* && "$FAIL_EXTENSION" == 1 ]]; then exit 1; fi\n',
    { mode: 0o700 },
  );
  const script = join(dir, "wrapper.sh");
  writeFileSync(
    script,
    source.replaceAll("/var/run/postgresql/openmapx-password-synced", join(dir, "sentinel")),
  );
  const result = spawnSync("bash", [script, ...args], {
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      PG_STAT_STATEMENTS: flag,
      PGDATA: join(dir, "absent"),
      POSTGRES_PASSWORD: "synthetic-password",
      HARNESS_LOG: log,
      FAIL_EXTENSION: failExtension ? "1" : "0",
    },
    encoding: "utf8",
    timeout: 4000,
  });
  return {
    ...result,
    log: (() => {
      try {
        return readFileSync(log, "utf8");
      } catch {
        return "";
      }
    })(),
  };
}
describe("PostGIS opt-in diagnostics startup", () => {
  it("keeps disabled startup free of diagnostics settings", () => {
    const result = run("false");
    expect(result.status).toBe(0);
    expect(result.log).not.toContain("pg_stat_statements");
  });
  it("enables safe fixed settings and creates the extension after password sync", () => {
    const result = run("true");
    expect(result.status).toBe(0);
    expect(result.log).toContain("shared_preload_libraries=pg_stat_statements");
    expect(result.log).toContain("pg_stat_statements.track_utility=off");
    expect(result.log).toContain("pg_stat_statements.save=off");
    expect(result.log.indexOf("ALTER USER")).toBeLessThan(result.log.indexOf("CREATE EXTENSION"));
    expect(result.stdout + result.stderr).not.toContain("synthetic-password");
  });
  it("fails closed on an invalid flag before starting PostgreSQL", () => {
    const result = run("maybe");
    expect(result.status).not.toBe(0);
    expect(result.log).toBe("");
  });
  it("rejects conflicting preload arguments without overwriting them", () => {
    const result = run("true", false, ["postgres", "-c", "shared_preload_libraries=other"]);
    expect(result.status).not.toBe(0);
    expect(result.log).toBe("");
  });
  it.each([
    ["-D", "/operator-data"],
    ["--data-directory=/operator-data"],
    ["-c", "data_directory=/operator-data"],
  ])(
    "rejects alternate data directories before bypassing preload inspection: %s",
    (...args: string[]) => {
      const result = run("true", false, ["postgres", ...args]);
      expect(result.status).not.toBe(0);
      expect(result.log).toBe("");
    },
  );
  it("does not report readiness when extension activation fails", () => {
    const result = run("true", true);
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("diagnostics ready");
  });
});
