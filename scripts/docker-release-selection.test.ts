import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadPreviousRelease } from "./docker-release-plan.mjs";

const sha = "a".repeat(40);
const digest = `sha256:${"b".repeat(64)}`;
const release = `${sha}-123-2`;
const workflow = readFileSync(
  resolve(import.meta.dirname, "../.github/workflows/docker.yml"),
  "utf8",
);
const planner = resolve(import.meta.dirname, "docker-release-plan.mjs");

describe("previous published release acquisition", () => {
  it("bootstraps only on an explicit missing manifest", () => {
    expect(
      loadPreviousRelease("example.invalid/release-manifest:latest", () => ({
        status: 1,
        stderr: "manifest unknown",
      })),
    ).toBeNull();
  });
  it.each(["unauthorized", "connection timed out", "permission denied"])(
    "fails closed on %s",
    (stderr) => {
      expect(() =>
        loadPreviousRelease("example.invalid/release-manifest:latest", () => ({
          status: 1,
          stderr,
        })),
      ).toThrow("Cannot read previous release");
    },
  );
  it.each([false, true])(
    "copies the pulled local image ID and cleans up, malformed JSON=%s",
    (malformed) => {
      const calls: string[][] = [];
      const container = "c".repeat(64);
      let copiedTo = "";
      const acquire = () =>
        loadPreviousRelease("example.invalid/release-manifest:latest", (args: string[]) => {
          calls.push(args);
          if (args[0] === "image") return { status: 0, stdout: digest };
          if (args[0] === "create") return { status: 0, stdout: container };
          if (args[0] === "cp") {
            copiedTo = args[2];
            writeFileSync(copiedTo, malformed ? "invalid" : JSON.stringify({ release }));
          }
          return { status: 0, stdout: "" };
        });
      if (malformed) expect(acquire).toThrow();
      else expect(acquire()).toEqual({ release });
      expect(calls).toContainEqual(["create", digest, "true"]);
      expect(calls).toContainEqual(["cp", `${container}:/release-manifest.json`, copiedTo]);
      expect(calls.at(-1)).toEqual(["rm", "-f", container]);
      expect(existsSync(copiedTo)).toBe(false);
    },
  );
});

function select(patch: Record<string, unknown> = {}, selectedPatch: Record<string, unknown> = {}) {
  const temp = mkdtempSync(join(tmpdir(), "openmapx-selection-"));
  try {
    const plan = join(temp, "plan.json");
    const output = join(temp, "output");
    writeFileSync(
      plan,
      JSON.stringify({
        version: 1,
        release,
        sourceRevision: sha,
        images: [
          {
            app: "api",
            rebuild: false,
            refresh: false,
            digest,
            reason: "unchanged",
            ...selectedPatch,
          },
        ],
        ...patch,
      }),
    );
    const result = spawnSync(process.execPath, [planner, "select", "api", plan], {
      encoding: "utf8",
      env: { ...process.env, RELEASE_SHA: sha, RELEASE_ID: release, GITHUB_OUTPUT: output },
    });
    return {
      status: result.status,
      output: existsSync(output) ? readFileSync(output, "utf8") : "",
    };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

describe("build selection and mandatory scanning", () => {
  it("exports the prior exact digest for reuse", () => {
    expect(select()).toEqual({
      status: 0,
      output: `rebuild=false\nrefresh=false\ndigest=${digest}\n`,
    });
  });
  it("does not expose a fallback digest for a required rebuild", () => {
    expect(select({}, { rebuild: true, refresh: true })).toEqual({
      status: 0,
      output: "rebuild=true\nrefresh=true\ndigest=\n",
    });
  });
  it.each([{ release: `${sha}-123-1` }, { sourceRevision: "b".repeat(40) }, { version: 2 }])(
    "rejects another run, checkout, or schema: %s",
    (patch) => {
      expect(select(patch)).toEqual({ status: 1, output: "" });
    },
  );
  it("rejects unpullable or injected reused image references", () => {
    expect(select({}, { digest: "latest\nrebuild=false" })).toEqual({ status: 1, output: "" });
  });
  it.each([true, false])(
    "scans the selected digest (rebuild=%s) and never falls back after an empty build result",
    (rebuild) => {
      const block = workflow.slice(
        workflow.indexOf("      - name: Select the exact digest to scan"),
        workflow.indexOf("      # Keep the complete finding set"),
      );
      const script = block
        .split("        run: |\n")[1]
        .split("\n")
        .map((line) => line.slice(10))
        .join("\n");
      const temp = mkdtempSync(join(tmpdir(), "openmapx-candidate-"));
      try {
        const output = join(temp, "output");
        const run = (built: string) =>
          spawnSync("bash", ["-euo", "pipefail", "-c", script], {
            encoding: "utf8",
            env: {
              ...process.env,
              REBUILD: String(rebuild),
              BUILT_DIGEST: built,
              REUSED_DIGEST: digest,
              GITHUB_OUTPUT: output,
            },
          });
        expect(run(`sha256:${"d".repeat(64)}`).status).toBe(0);
        expect(readFileSync(output, "utf8")).toBe(
          `digest=${rebuild ? `sha256:${"d".repeat(64)}` : digest}\n`,
        );
        if (rebuild) expect(run("").status).toBe(1);
      } finally {
        rmSync(temp, { recursive: true, force: true });
      }
      for (const name of [
        "Audit exact candidate digest with Trivy",
        "Gate exact candidate digest with Trivy",
      ]) {
        const start = workflow.indexOf(`      - name: ${name}`);
        const step = workflow.slice(start, workflow.indexOf("      - name:", start + 10));
        expect(step).toContain("steps.candidate.outputs.digest");
        expect(step).not.toMatch(/^ {8}if:/m);
        expect(step).not.toContain("continue-on-error:");
      }
    },
  );
});
