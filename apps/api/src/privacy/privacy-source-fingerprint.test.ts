import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { computePrivacySourceFingerprint } from "../../privacy-source-fingerprint.mjs";

describe("privacy source fingerprint", () => {
  it("covers deployed API, workspace, collectors, permissions, schemas and legal copy", async () => {
    const root = await mkdtemp(join(tmpdir(), "openmapx-privacy-fingerprint-"));
    const paths = [
      "apps/api/esbuild.config.mjs",
      "apps/api/Dockerfile",
      "apps/api/package.json",
      "apps/ops-agent/tsconfig.build.json",
      "packages/core/package.json",
      "packages/i18n/package.json",
      "apps/api/src/privacy/readiness.ts",
      "apps/api/src/server.ts",
      "apps/api/src/auth.ts",
      "apps/api/src/db/privacy-auth-schema.ts",
      "apps/api/src/services/user-erasure.ts",
      "packages/core/src/privacy/contracts.ts",
      "packages/core/src/services/manifest-schema.ts",
      "packages/core/src/utils/legalConfig.ts",
      "packages/cli/src/commands/backup.ts",
      "apps/ops-agent/src/privacy-backup-extraction.ts",
      "apps/ops-agent/src/descriptor-file.ts",
      "apps/ops-agent/src/dawarich-subject-export.ts",
      "services/ops-agent/privacy-backup/openmapx-backup-subject-export.py",
      "services/dawarich-app/scripts/openmapx-subject-export.rb",
      "services/dawarich-app/scripts/subject_export/schema.rb",
      "services/ops-agent/service.json",
      "packages/i18n/locales/en.json",
      "apps/web/src/app/(legal)/privacy/content.en.tsx",
      "apps/web/src/app/admin/privacy/page.tsx",
      "apps/web/src/components/auth/AuthDialog.tsx",
    ];
    for (const path of paths) {
      await mkdir(join(root, path, ".."), { recursive: true });
      await writeFile(join(root, path), `initial:${path}`);
    }
    const current = await computePrivacySourceFingerprint(root, { allowMissingTargets: true });
    const changed: string[] = [];
    for (const path of paths) {
      await writeFile(join(root, path), `changed:${path}`);
      changed.push(await computePrivacySourceFingerprint(root, { allowMissingTargets: true }));
      await writeFile(join(root, path), `initial:${path}`);
    }
    expect(new Set(changed).size).toBe(paths.length);
    expect(changed).not.toContain(current);
  });

  it("ignores test-only files and filesystem enumeration order", async () => {
    const root = await mkdtemp(join(tmpdir(), "openmapx-privacy-fingerprint-"));
    const source = join(root, "apps/api/src/privacy/readiness.ts");
    await mkdir(join(source, ".."), { recursive: true });
    await writeFile(source, "release source");
    const current = await computePrivacySourceFingerprint(root, { allowMissingTargets: true });
    await writeFile(join(root, "apps/api/src/privacy/readiness.test.ts"), "test-only change");
    expect(await computePrivacySourceFingerprint(root, { allowMissingTargets: true })).toBe(
      current,
    );
  });

  it("fails closed when a required deployed target is absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "openmapx-privacy-fingerprint-"));
    await expect(computePrivacySourceFingerprint(root)).rejects.toThrow(
      "Missing privacy source fingerprint targets",
    );
  });
});
