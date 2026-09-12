import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  resolve(import.meta.dirname, "../.github/workflows/docs.yml"),
  "utf8",
);
const sha = "a".repeat(40);
const digest = `sha256:${"b".repeat(64)}`;

describe("independent docs publication", () => {
  it.each(["ok", "pull-failure", "missing-digest", "compose-pull-failure"])(
    "deploy instructions pin one digest and stop on %s",
    (scenario) => {
      const readme = readFileSync(resolve(import.meta.dirname, "../docs/README.md"), "utf8");
      const script = readme.split("```bash\n")[2]?.split("```")[0];
      if (!script) throw new Error("Missing deployment instructions");
      const temp = mkdtempSync(join(tmpdir(), "openmapx-docs-deploy-"));
      try {
        writeFileSync(
          join(temp, "docker"),
          `#!/bin/sh
printf '%s | %s\\n' "$*" "$OPENMAPX_DOCS_IMAGE" >> "$CALLS"
case "$*" in
  'pull '*) [ "$SCENARIO" != pull-failure ];;
  'image inspect '*) cat "$INSPECT";;
  *' pull') [ "$SCENARIO" != compose-pull-failure ];;
esac
`,
        );
        chmodSync(join(temp, "docker"), 0o755);
        writeFileSync(
          join(temp, "inspect"),
          JSON.stringify([
            {
              RepoDigests:
                scenario === "missing-digest"
                  ? []
                  : [`example.org/docs@${digest}`, `ghcr.io/openmapx/docs@${digest}`],
            },
          ]),
        );
        const result = spawnSync("bash", ["-c", script], {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${temp}:${process.env.PATH}`,
            CALLS: join(temp, "calls"),
            INSPECT: join(temp, "inspect"),
            SCENARIO: scenario,
          },
        });
        expect(result.status).toBe(scenario === "ok" ? 0 : 1);
        const calls = readFileSync(join(temp, "calls"), "utf8");
        if (scenario === "ok") expect(calls).toContain(`up -d | ghcr.io/openmapx/docs@${digest}`);
        else expect(calls).not.toContain("up -d");
      } finally {
        rmSync(temp, { recursive: true, force: true });
      }
    },
  );
  it("runs on its own source changes and weekly refresh, without an application CI dependency", () => {
    expect(workflow).toContain('"docs/**"');
    expect(workflow).toContain("schedule:");
    expect(workflow).toContain("pull_request:");
    expect(workflow).toContain("branches: [main]");
    expect(workflow).not.toMatch(/workflow_run:|workflow_call:|needs:/);
    expect(workflow).not.toContain("release-manifest");
    expect(workflow).toContain("context: docs");
    expect(workflow).toContain("push-by-digest=true");
    expect(workflow).toContain("no-cache: ${{ github.event_name == 'schedule'");
  });
  it("gates main publication on two exact-digest scans and never publishes PR images", () => {
    const build = workflow.indexOf("- name: Build docs candidate");
    const audit = workflow.indexOf("- name: Audit docs candidate");
    const gate = workflow.indexOf("- name: Gate docs candidate");
    const publish = workflow.indexOf("- name: Publish and verify docs aliases");
    expect(build).toBeGreaterThan(0);
    expect(audit).toBeGreaterThan(build);
    expect(gate).toBeGreaterThan(audit);
    expect(publish).toBeGreaterThan(gate);
    for (const start of [audit, gate, publish]) {
      const end = workflow.indexOf("      - name:", start + 10);
      const step = workflow.slice(start, end < 0 ? undefined : end);
      expect(step).toContain("if: github.event_name != 'pull_request'");
      expect(step).not.toContain("continue-on-error:");
    }
    expect(workflow).toContain('exit-code: "1"');
    expect(workflow).toContain('ignore-unfixed: "true"');
  });
  it.each([false, true])(
    "publishes only the approved digest and rejects mismatches=%s",
    (mismatch) => {
      const start = workflow.indexOf("      - name: Publish and verify docs aliases");
      const run = workflow.slice(start).match(/ {8}run: \|\n((?: {10}.*\n|\n)*)/)?.[1];
      if (!run) throw new Error("Missing docs publication script");
      const script = run
        .split("\n")
        .map((line) => line.slice(10))
        .join("\n");
      const temp = mkdtempSync(join(tmpdir(), "openmapx-docs-publish-"));
      try {
        const docker = join(temp, "docker");
        writeFileSync(
          docker,
          `#!/bin/sh\nprintf '%s\\n' "$*" >> "$CALLS"\ncase "$*" in *inspect*) echo "$EXPECTED";; esac\n`,
        );
        chmodSync(docker, 0o755);
        const result = spawnSync("bash", ["-euo", "pipefail", "-c", script], {
          cwd: temp,
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${temp}:${process.env.PATH}`,
            CALLS: join(temp, "calls"),
            EXPECTED: mismatch ? `sha256:${"c".repeat(64)}` : digest,
            IMAGE: "ghcr.io/openmapx/docs",
            RELEASE_SHA: sha,
            RELEASE_ID: `${sha}-1-1`,
            DIGEST: digest,
            GITHUB_STEP_SUMMARY: join(temp, "summary"),
          },
        });
        expect(result.status).toBe(mismatch ? 1 : 0);
        const calls = readFileSync(join(temp, "calls"), "utf8");
        expect(calls).toContain(`ghcr.io/openmapx/docs@${digest}`);
        expect(calls).toContain(`--tag ghcr.io/openmapx/docs:${sha}-1-1`);
        if (mismatch) expect(calls).not.toContain("--tag ghcr.io/openmapx/docs:latest");
        else expect(calls).toContain("--tag ghcr.io/openmapx/docs:latest");
      } finally {
        rmSync(temp, { recursive: true, force: true });
      }
    },
  );
});
