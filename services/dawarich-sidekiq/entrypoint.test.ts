import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const wrapperPath = join(__dirname, "scripts", "openmapx-entrypoint.sh");
const secretNames = ["DATABASE_PASSWORD", "SECRET_KEY_BASE", "OIDC_CLIENT_SECRET"];
let sandbox: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "openmapx-dawarich-sidekiq-entrypoint-"));
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

function runHarness(secrets: Partial<Record<(typeof secretNames)[number], string>>) {
  const secretDir = join(sandbox, "secrets");
  mkdirSync(secretDir);
  for (const [name, value] of Object.entries(secrets)) {
    writeFileSync(join(secretDir, name), value, { mode: 0o400 });
  }

  const stockEntrypoint = join(sandbox, "stock-entrypoint.sh");
  writeFileSync(
    stockEntrypoint,
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal POSIX parameter expansion in the synthetic script
    '#!/bin/sh\nprintf "loaded:%s:%s:%s args:%s\\n" "${#DATABASE_PASSWORD}" "${#SECRET_KEY_BASE}" "${#OIDC_CLIENT_SECRET}" "$*"\n',
    { mode: 0o700 },
  );

  const source = readFileSync(wrapperPath, "utf-8")
    .replaceAll("/run/secrets", secretDir)
    .replace("/usr/local/bin/sidekiq-entrypoint.sh", stockEntrypoint);
  const harness = join(sandbox, "openmapx-entrypoint.sh");
  writeFileSync(harness, source, { mode: 0o700 });
  chmodSync(harness, 0o700);
  return spawnSync("/bin/sh", [harness, "sidekiq"], { encoding: "utf-8" });
}

describe("Dawarich Sidekiq secret-file entrypoint", () => {
  it("loads only the three declared secrets and execs the stock worker entrypoint with original args", () => {
    const result = runHarness({
      DATABASE_PASSWORD: "db-secret-123",
      SECRET_KEY_BASE: "rails-secret-456",
      OIDC_CLIENT_SECRET: "oidc-secret-789",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("loaded:13:16:15 args:sidekiq\n");
    expect(result.stdout + result.stderr).not.toContain("db-secret-123");
    expect(result.stdout + result.stderr).not.toContain("rails-secret-456");
    expect(result.stdout + result.stderr).not.toContain("oidc-secret-789");
  });

  it("fails closed when a declared secret file is missing without revealing loaded values", () => {
    const result = runHarness({
      DATABASE_PASSWORD: "db-secret-123",
      SECRET_KEY_BASE: "rails-secret-456",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("OIDC_CLIENT_SECRET");
    expect(result.stdout + result.stderr).not.toContain("db-secret-123");
    expect(result.stdout + result.stderr).not.toContain("rails-secret-456");
  });

  it("has valid POSIX shell syntax and a narrow static security boundary", () => {
    const syntax = spawnSync("/bin/sh", ["-n", wrapperPath], { encoding: "utf-8" });
    expect(syntax.status).toBe(0);

    const source = readFileSync(wrapperPath, "utf-8");
    expect([...source.matchAll(/^load_secret ([A-Z_]+)$/gm)].map((match) => match[1])).toEqual(
      secretNames,
    );
    expect(source).toContain('exec /usr/local/bin/sidekiq-entrypoint.sh "$@"');
    expect(source).not.toMatch(/\beval\b/);
    expect(source).not.toMatch(/set\s+-[^\n]*x/);
    expect(source).not.toContain("echo");
  });
});
