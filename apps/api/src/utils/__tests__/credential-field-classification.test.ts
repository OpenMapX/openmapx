// @vitest-environment node
// Repo-wide static guardrail: every credential-like configSchema field must be
// marked `x-openmapx-secret: true`. Such fields are vault-backed and render only
// on the admin **Credentials** tab; everything else renders on **Config**. A
// credential field missing the marker leaks into the Config form (plaintext) and
// never appears under Credentials — the exact bug this test prevents.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, "integrations")) && existsSync(join(dir, "services"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("Could not locate repo root (no dir with integrations/ + services/)");
}

function manifestPaths(): string[] {
  const root = repoRoot();
  const out: string[] = [];
  for (const [base, file] of [
    ["integrations", "manifest.json"],
    ["services", "service.json"],
  ] as const) {
    const baseDir = join(root, base);
    if (!existsSync(baseDir)) continue;
    for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith("_") || entry.name.startsWith("."))
        continue;
      const p = join(baseDir, entry.name, file);
      if (existsSync(p)) out.push(p);
    }
  }
  return out;
}

interface FieldDef {
  format?: string;
  "x-openmapx-secret"?: unknown;
  "x-openmapx-setup"?: unknown;
}

/**
 * A field is "credential-like" when it is a masked input (`format: "password"`)
 * or carries an `x-openmapx-setup` guide (the "how to obtain this API key" block
 * is only attached to credentials). Both are unambiguous credential signals.
 */
function isCredentialLike(def: FieldDef): boolean {
  return def.format === "password" || def["x-openmapx-setup"] !== undefined;
}

function findViolations(): string[] {
  const violations: string[] = [];
  for (const p of manifestPaths()) {
    let m: { configSchema?: { properties?: Record<string, FieldDef> } };
    try {
      m = JSON.parse(readFileSync(p, "utf-8"));
    } catch {
      continue;
    }
    const props = m.configSchema?.properties ?? {};
    for (const [key, def] of Object.entries(props)) {
      if (!def || typeof def !== "object") continue;
      if (isCredentialLike(def) && def["x-openmapx-secret"] !== true) {
        violations.push(`${p} :: field "${key}" is credential-like but not x-openmapx-secret:true`);
      }
    }
  }
  return violations;
}

describe("configSchema credential classification", () => {
  it("marks every credential-like field x-openmapx-secret:true (so it lives only on Credentials, not Config)", () => {
    const violations = findViolations();
    expect(violations, `\n${violations.join("\n")}\n`).toEqual([]);
  });

  it("actually scans manifests (guards against a broken path)", () => {
    expect(manifestPaths().length).toBeGreaterThan(20);
  });
});
