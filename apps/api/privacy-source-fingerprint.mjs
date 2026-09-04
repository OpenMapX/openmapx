import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, relative } from "node:path";

const TARGETS = [
  "apps/api/privacy-source-fingerprint.mjs",
  "apps/api/esbuild.config.mjs",
  "apps/api/Dockerfile",
  "apps/api/package.json",
  "apps/api/tsconfig.json",
  "apps/api/tsconfig.build.json",
  "apps/api/openapi.json",
  "apps/api/src/server.ts",
  "apps/api/src/auth.ts",
  "apps/api/src/privacy",
  "apps/api/src/routes/privacy-admin.ts",
  "apps/api/src/routes/privacy-requests.ts",
  "apps/api/src/routes/privacy-roles.ts",
  "apps/api/src/routes/legal-config.ts",
  "apps/api/src/utils/require-privacy-admin.ts",
  "apps/api/src/db",
  "apps/api/src/services/activity-retention.ts",
  "apps/api/src/services/mobileAuthHandoff.ts",
  "apps/api/src/services/offline-package-principal.ts",
  "apps/api/src/services/user-erasure.ts",
  "apps/api/src/utils/csrf.ts",
  "apps/ops-agent/src/administrative-runtime.ts",
  "apps/ops-agent/src/data-inventory.ts",
  "apps/ops-agent/src/descriptor-file.ts",
  "apps/ops-agent/src/dawarich-subject-export.ts",
  "apps/ops-agent/src/privacy-backup-extraction.ts",
  "apps/ops-agent/src/privacy-backup-runtime.ts",
  "apps/ops-agent/src/policy.ts",
  "apps/ops-agent/src/server.ts",
  "apps/ops-agent/Dockerfile",
  "apps/ops-agent/package.json",
  "apps/ops-agent/tsconfig.json",
  "apps/ops-agent/tsconfig.build.json",
  "apps/web/src/app/(legal)/privacy",
  "apps/web/src/app/admin/privacy",
  "apps/web/src/app/auth/privacy",
  "apps/web/src/app/settings/privacy",
  "apps/web/src/components/auth/AuthDialog.tsx",
  "apps/web/src/components/auth/PrivacyDataSection.tsx",
  "packages/core/src/ops",
  "packages/core/package.json",
  "packages/core/tsconfig.json",
  "packages/core/src/privacy",
  "packages/core/src/erasure-journal.ts",
  "packages/core/src/services",
  "packages/core/src/utils/legalConfig.ts",
  "packages/cli/src/commands/backup.ts",
  "packages/cli/src/commands/compose.ts",
  "packages/cli/src/lib/platform-secret-files.ts",
  "packages/cli/package.json",
  "packages/i18n/config.ts",
  "packages/i18n/package.json",
  "packages/i18n/tsconfig.json",
  "packages/i18n/index.ts",
  "packages/i18n/locales/de.json",
  "packages/i18n/locales/en.json",
  "packages/i18n/translator.ts",
  "packages/i18n/navigationCues.ts",
  "scripts/check-subject-data.ts",
  "scripts/validate-privacy-release.mjs",
  "services/app-api/service.json",
  "services/ops-agent/service.json",
  "services/dawarich-app/scripts",
  "services/dawarich-app/service.json",
  "services/ops-agent/privacy-backup",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.base.json",
  "turbo.json",
];

function deployedSource(path) {
  const name = basename(path);
  if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(name)) return false;
  if (name.endsWith("_snapshot.json")) return false;
  if (["README.md", "test-fixture.mjs", "verify-output.ts"].includes(name)) return false;
  return !path.split("/").some((part) => ["__tests__", "fixtures", "__pycache__"].includes(part));
}

async function collect(path, files) {
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return false;
    throw error;
  }
  if (info.isFile()) {
    if (deployedSource(path)) files.push(path);
    return true;
  }
  if (!info.isDirectory()) return true;
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    await collect(join(path, entry.name), files);
  }
  return true;
}

/** Hash every deployed file that implements the reviewed privacy workflow.
 * Paths and bytes are framed independently so concatenation cannot collide. */
export async function computePrivacySourceFingerprint(repoRoot, options = {}) {
  const files = [];
  const missing = [];
  for (const target of TARGETS) {
    if (!(await collect(join(repoRoot, target), files))) missing.push(target);
  }
  if (missing.length > 0 && options.allowMissingTargets !== true)
    throw new Error(`Missing privacy source fingerprint targets: ${missing.join(", ")}`);
  files.sort((left, right) => relative(repoRoot, left).localeCompare(relative(repoRoot, right)));
  const hash = createHash("sha256");
  hash.update("openmapx/privacy/source-build/v1\0");
  for (const file of files) {
    const path = relative(repoRoot, file).split("\\").join("/");
    const bytes = await readFile(file);
    hash.update(String(Buffer.byteLength(path)));
    hash.update(":");
    hash.update(path);
    hash.update(":");
    hash.update(String(bytes.byteLength));
    hash.update(":");
    hash.update(bytes);
    hash.update("\0");
  }
  return hash.digest("hex");
}
