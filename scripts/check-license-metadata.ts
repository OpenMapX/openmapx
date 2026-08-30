/**
 * License-metadata gate for OpenMapX packages.
 *
 * CHECK (default): verifies every workspace package.json declares the `license`
 * and `private` flag required by the policy below, and exits non-zero on drift.
 * Mirrors the other scripts/check-*.ts gates (run in pre-commit).
 *
 * WRITE (`--write`): applies the policy in place — use when onboarding a new
 * package or after changing the policy. Edits are line-based so the resulting
 * diff is one changed/added line per file; property order is preserved.
 *
 *   Reusable substrate (extension tooling + shared `core`/libs) -> Apache-2.0
 *   The product (app, integrations, services, app-internal packages) -> AGPL-3.0-or-later
 *   Vendored third-party code -> kept under its upstream license
 *
 * See LICENSING.md for the rationale.
 *
 * Run:  pnpm check-license-metadata           (check)
 *       pnpm check-license-metadata --write    (apply)
 */
import {
  copyFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = typeof __dirname !== "undefined" ? __dirname : dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

const APACHE = "Apache-2.0";
const AGPL = "AGPL-3.0-or-later";
const MIT = "MIT";

/**
 * The reusable substrate: extension tooling, the shared `core` foundation that
 * nearly every integration imports, and the standalone data libraries.
 * Permissive so anyone can build their own app or new integrations on top.
 */
const APACHE_PACKAGES = new Set([
  "integration-framework",
  "air-quality", // reusable evidence, standards, jurisdiction, and selection foundation
  "core", // Nearly all integrations depend on it; it is the shared foundation
  "extension-cli", // standalone Apache-2.0 authoring CLI (scaffold / package / validate)
  "presets", // integration-poi-search depends on it
  "brands", // brand/chain catalog distilled from NSI, mirrors presets
  "mobility-formats",
  "mobility-formats-tomp",
  "mobility-core",
  "place-ids",
  "poi-source-registry",
  "motis-feed-proxy-config",
  "transitous-core",
  "hardlinks",
  "mangrove-client",
  "mangrove-react",
  "openconditions-contrib-client", // reusable ES256 crowd-report signing lib (mirrors Apache-2.0 contrib-core)
  "noaa-coops-data",
  "ourairports-data",
]);

/** Vendored upstream code we must not relicense. */
const VENDORED: Record<string, string> = {
  "hey-api-client-fetch": MIT,
};

/** Packages currently meant to be published to npm (not `private`). */
const PUBLIC_PACKAGES = new Set(["core", "extension-cli"]);

type Plan = { spdx: string; keepPrivate: boolean };

function planFor(
  dir: "packages" | "integrations" | "apps" | "services",
  name: string,
): Plan | null {
  const keepPrivate = dir !== "packages" || !PUBLIC_PACKAGES.has(name);
  if (dir === "packages") {
    if (VENDORED[name]) return { spdx: VENDORED[name], keepPrivate };
    // Reusable libs are Apache-2.0 but kept `private` for now (except `core`,
    // which is already published); add to PUBLIC_PACKAGES when ready to publish.
    if (APACHE_PACKAGES.has(name)) return { spdx: APACHE, keepPrivate };
    return { spdx: AGPL, keepPrivate };
  }
  // integrations, apps, services are all the product -> AGPL.
  return { spdx: AGPL, keepPrivate };
}

/**
 * Ensure a top-level `"key": value` exists with the given value. Replaces an
 * existing occurrence (preserving its trailing comma) or inserts after the first
 * anchor key — correctly handling the case where the anchor is the object's LAST
 * property (no trailing comma), which the previous comma-anchored version could
 * not. Line-based so diffs stay minimal and property order is preserved.
 */
function ensureKey(text: string, key: string, value: string | boolean, anchors: string[]): string {
  const literal = JSON.stringify(value);
  const lines = text.split("\n");
  const keyRe = new RegExp(`^(\\s*)"${key}"\\s*:\\s*[^,]*?(,?)\\s*$`);
  for (let i = 0; i < lines.length; i++) {
    const m = keyRe.exec(lines[i]);
    if (m) {
      lines[i] = `${m[1]}"${key}": ${literal}${m[2] ? "," : ""}`;
      return lines.join("\n");
    }
  }
  const anchorRe = new RegExp(`^(\\s*)"(?:${anchors.join("|")})"\\s*:\\s*.*?(,?)\\s*$`);
  for (let i = 0; i < lines.length; i++) {
    const m = anchorRe.exec(lines[i]);
    if (m) {
      if (m[2]) {
        // Anchor already has a trailing comma → more properties follow.
        lines.splice(i + 1, 0, `${m[1]}"${key}": ${literal},`);
      } else {
        // Anchor is the last property → give it a comma, append without one.
        lines[i] = `${lines[i].replace(/\s*$/, "")},`;
        lines.splice(i + 1, 0, `${m[1]}"${key}": ${literal}`);
      }
      return lines.join("\n");
    }
  }
  return text;
}

/**
 * Returns `text` with the policy applied. A package is in policy iff this is a
 * no-op.
 */
function applyPolicy(text: string, plan: Plan): string {
  let out = ensureKey(text, "license", plan.spdx, ["name", "version"]);
  if (plan.keepPrivate) {
    out = ensureKey(out, "private", true, ["version", "name"]);
  } else {
    // Publishable: drop any `private` line (true OR false), then heal a comma
    // left dangling before the closing brace if it was the last property.
    out = out
      .split("\n")
      .filter((l) => !/^\s*"private"\s*:\s*(true|false)\s*,?\s*$/.test(l))
      .join("\n")
      .replace(/,(\s*\n\s*})/g, "$1");
  }
  return out;
}

/** A LICENSE file is recognized as a given license by this marker phrase. */
const LICENSE_MARKER: Record<string, string> = {
  [AGPL]: "GNU AFFERO GENERAL PUBLIC LICENSE",
  [APACHE]: "Apache License",
  [MIT]: "MIT License",
};

function detectFamily(text: string): string | null {
  for (const [spdx, marker] of Object.entries(LICENSE_MARKER)) {
    if (text.includes(marker)) return spdx;
  }
  return null;
}

/**
 * Canonical LICENSE templates discovered from existing files in the repo (root
 * is AGPL; the first packages/* of each family seeds Apache/MIT). Lets --write
 * create a missing LICENSE by copying an authoritative text already in the tree,
 * rather than embedding full license bodies in this script.
 */
function discoverTemplates(): Record<string, string> {
  const out: Record<string, string> = {};
  const consider = (p: string) => {
    if (!existsSync(p)) return;
    const fam = detectFamily(readFileSync(p, "utf8"));
    if (fam && !out[fam]) out[fam] = p;
  };
  consider(join(ROOT, "LICENSE"));
  const pkgBase = join(ROOT, "packages");
  if (existsSync(pkgBase)) {
    for (const n of readdirSync(pkgBase)) consider(join(pkgBase, n, "LICENSE"));
  }
  return out;
}

const WRITE = process.argv.includes("--write");
// Templates are only needed to create missing LICENSE files in --write mode;
// don't scan them on every check (pre-commit hot path).
const templates = WRITE ? discoverTemplates() : {};
const drift: { pkg: string; issue: string }[] = [];
let changedFields = 0;
let changedLicenses = 0;

for (const dir of ["packages", "integrations", "apps", "services"] as const) {
  const base = join(ROOT, dir);
  if (!existsSync(base)) continue;
  for (const name of readdirSync(base)) {
    if (name.startsWith("_") || name.startsWith(".")) continue;
    const pkgDir = join(base, name);
    const pkgPath = join(pkgDir, "package.json");
    if (!existsSync(pkgPath) || !statSync(pkgPath).isFile()) continue;
    const plan = planFor(dir, name);
    if (!plan) continue;

    // 1. package.json `license` + `private` fields.
    const before = readFileSync(pkgPath, "utf8");
    const after = applyPolicy(before, plan);
    if (after !== before) {
      if (WRITE) {
        writeFileSync(pkgPath, after);
        changedFields++;
      } else {
        drift.push({
          pkg: `${dir}/${name}`,
          issue: `package.json: expected license "${plan.spdx}"${plan.keepPrivate ? ' + "private": true' : " (publishable)"}`,
        });
      }
    }

    // 2. LICENSE file — required only for the publishable tier (packages/*).
    //    apps/integrations/services are covered by the root AGPL LICENSE.
    if (dir === "packages") {
      const licPath = join(pkgDir, "LICENSE");
      const marker = LICENSE_MARKER[plan.spdx];
      const licOk =
        existsSync(licPath) && !!marker && readFileSync(licPath, "utf8").includes(marker);
      if (!licOk) {
        const tpl = templates[plan.spdx];
        if (WRITE && tpl) {
          copyFileSync(tpl, licPath);
          changedLicenses++;
        } else {
          const why = existsSync(licPath)
            ? `LICENSE file does not match declared "${plan.spdx}"`
            : "missing LICENSE file";
          drift.push({
            pkg: `${dir}/${name}`,
            issue: `${why}${WRITE && !tpl ? " (no template found to copy)" : ""}`,
          });
        }
      }
    }
  }
}

if (WRITE) {
  console.log(
    `License metadata: updated ${changedFields} package.json field set(s) and ${changedLicenses} LICENSE file(s).`,
  );
  if (drift.length > 0) {
    console.error(
      `\n✗ Could not auto-fix:\n${drift.map((d) => `   ${d.pkg} — ${d.issue}`).join("\n")}`,
    );
    process.exit(1);
  }
} else if (drift.length > 0) {
  console.error(
    `✗ License metadata is out of policy in ${drift.length} place(s):\n${drift
      .map((d) => `   ${d.pkg} — ${d.issue}`)
      .join("\n")}\n\nFix automatically with:  pnpm check-license-metadata --write`,
  );
  process.exit(1);
} else {
  console.log("✓ License metadata matches policy for all packages.");
}
