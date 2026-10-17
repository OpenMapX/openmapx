import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
      const mainBase = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: fixture,
        encoding: "utf8",
      }).trim();
      git(["commit", "--no-verify", "-m", "resolved same-day merge"]);
      const merged = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: fixture,
        encoding: "utf8",
      }).trim();
      const verifyCommitted = () =>
        spawnSync(process.execPath, [join(scriptsDir, "check-legal-updated.ts")], {
          cwd: fixture,
          encoding: "utf8",
          env: { ...process.env, OPENMAPX_POLICY_BASE: mainBase },
        });
      expect(verifyCommitted().status).toBe(0);
      // GitHub checks a synthetic merge of main and the already-resolved PR.
      git(["checkout", "-b", "ci", mainBase]);
      git(["merge", "--no-ff", "-m", "synthetic PR merge", merged]);
      expect(verifyCommitted().status).toBe(0);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});

describe("legal-date enforcement in CI", () => {
  it.each([
    {
      name: "rejects changed legal content with unchanged dates",
      change: true,
      bump: false,
      status: 1,
    },
    { name: "accepts unchanged legal content", change: false, bump: false, status: 0 },
    { name: "accepts a matching date update", change: true, bump: true, status: 0 },
  ])("$name with an empty Git index", ({ change, bump, status }) => {
    const fixture = mkdtempSync(join(tmpdir(), "openmapx-legal-ci-"));
    const scriptsDir = join(fixture, "scripts");
    mkdirSync(scriptsDir, { recursive: true });
    copyFileSync(
      join(SOURCE_ROOT, "scripts/check-legal-updated.ts"),
      join(scriptsDir, "check-legal-updated.ts"),
    );
    const git = (...args: string[]) =>
      execFileSync(
        "git",
        [
          "-c",
          "commit.gpgsign=false",
          "-c",
          "user.email=test@example.test",
          "-c",
          "user.name=Test",
          ...args,
        ],
        { cwd: fixture, encoding: "utf8" },
      );
    try {
      git("init", "-q");
      for (const page of ["privacy", "terms"]) {
        const dir = join(fixture, `apps/web/src/app/(legal)/${page}`);
        mkdirSync(dir, { recursive: true });
        privacy("August 8, 2026", "8. August 2026", dir);
      }
      git("add", ".");
      git("commit", "-qm", "base");
      const base = git("rev-parse", "HEAD").trim();
      if (change) {
        const dir = join(fixture, "apps/web/src/app/(legal)/privacy");
        privacy(
          bump ? "August 9, 2026" : "August 8, 2026",
          bump ? "9. August 2026" : "8. August 2026",
          dir,
        );
        for (const locale of ["en", "de"]) {
          const path = join(dir, `content.${locale}.tsx`);
          writeFileSync(path, `${readFileSync(path, "utf8")}New disclosure.\n`);
        }
        git("add", ".");
        git("commit", "-qm", "legal change");
      }
      expect(git("diff", "--cached")).toBe("");
      const run = (comparison: string) =>
        spawnSync(process.execPath, [join(scriptsDir, "check-legal-updated.ts")], {
          cwd: fixture,
          encoding: "utf8",
          env: { ...process.env, OPENMAPX_POLICY_BASE: comparison },
        });
      const result = run(base);
      expect(result.status, result.stderr).toBe(status);
      if (status) expect(result.stderr).toContain("date");
      expect(run("0".repeat(40)).status).toBe(1);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
