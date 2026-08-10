import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE_ROOT = resolve(import.meta.dirname, "..");

function privacy(enDate: string, deDate: string, body: string): void {
  writeFileSync(join(body, "content.en.tsx"), `Last updated: ${enDate}\n`);
  writeFileSync(join(body, "content.de.tsx"), `Zuletzt aktualisiert: ${deDate}\n`);
}

describe("check-legal-updated merge handling", () => {
  it("accepts a date advanced relative to the second parent during a same-day merge", () => {
    const fixture = mkdtempSync(join(tmpdir(), "openmapx-legal-merge-"));
    const privacyDir = join(fixture, "apps/web/src/app/(legal)/privacy");
    const termsDir = join(fixture, "apps/web/src/app/(legal)/terms");
    const scriptsDir = join(fixture, "scripts");
    mkdirSync(privacyDir, { recursive: true });
    mkdirSync(termsDir, { recursive: true });
    mkdirSync(scriptsDir, { recursive: true });
    copyFileSync(
      join(SOURCE_ROOT, "scripts/check-legal-updated.ts"),
      join(scriptsDir, "check-legal-updated.ts"),
    );

    const git = (args: string[]) =>
      execFileSync(
        "git",
        [
          "-c",
          "commit.gpgsign=false",
          "-c",
          "user.email=test@example.test",
          "-c",
          "user.name=OpenMapX Test",
          ...args,
        ],
        { cwd: fixture, stdio: "ignore" },
      );

    try {
      git(["init", "-b", "main"]);
      privacy("August 8, 2026", "8. August 2026", privacyDir);
      privacy("August 8, 2026", "8. August 2026", termsDir);
      git(["add", "."]);
      git(["commit", "--no-verify", "-m", "base legal copy"]);

      git(["checkout", "-b", "timeline"]);
      writeFileSync(
        join(privacyDir, "content.en.tsx"),
        "Last updated: August 9, 2026\ntimeline disclosure\n",
      );
      writeFileSync(
        join(privacyDir, "content.de.tsx"),
        "Zuletzt aktualisiert: 9. August 2026\nZeitleistenhinweis\n",
      );
      git(["add", "."]);
      git(["commit", "--no-verify", "-m", "timeline legal copy"]);

      git(["checkout", "main"]);
      writeFileSync(
        join(privacyDir, "content.en.tsx"),
        "Last updated: August 10, 2026\ncontribution disclosure\n",
      );
      writeFileSync(
        join(privacyDir, "content.de.tsx"),
        "Zuletzt aktualisiert: 10. August 2026\nBeitragshinweis\n",
      );
      git(["add", "."]);
      git(["commit", "--no-verify", "-m", "contribution legal copy"]);

      expect(() => git(["merge", "--no-commit", "--no-ff", "timeline"])).toThrow();
      writeFileSync(
        join(privacyDir, "content.en.tsx"),
        "Last updated: August 10, 2026\ncontribution disclosure\ntimeline disclosure\n",
      );
      writeFileSync(
        join(privacyDir, "content.de.tsx"),
        "Zuletzt aktualisiert: 10. August 2026\nBeitragshinweis\nZeitleistenhinweis\n",
      );
      git(["add", "."]);

      const result = spawnSync(
        "pnpm",
        ["-C", "packages/cli", "exec", "tsx", join(scriptsDir, "check-legal-updated.ts")],
        { cwd: SOURCE_ROOT, encoding: "utf8" },
      );
      if (result.status !== 0) throw new Error(result.stderr || result.stdout);
      expect(result.stdout).toContain('Legal "Last updated" dates are consistent');
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
