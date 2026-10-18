import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { fixture } from "./product-release.fixtures";
import { candidateHash, planProductRelease, readinessChecks } from "./product-release-plan.mjs";

vi.setConfig({ testTimeout: 60_000 });
type ExternalCall = { command: string; args: string[] };
type SyntheticRelease = {
  id: number;
  html_url: string;
  tag_name: string;
  target_commitish: string;
  name: string;
  body: string;
  draft: boolean;
  prerelease: boolean;
  immutable?: boolean;
  assets: Record<string, string>;
};
type SyntheticState = {
  input: ReturnType<typeof fixture>;
  latestAttempt: number;
  release: SyntheticRelease | null;
  registry: Record<string, string>;
  manifests: Record<string, unknown>;
  calls: ExternalCall[];
  published: number;
  authError?: number;
  tag?: string;
  parityMismatch?: boolean;
  previewFailure?: boolean;
  mutation?: { point: string; field: string };
};
function releaseOf(state: SyntheticState) {
  if (!state.release) throw new Error("Synthetic release has not been staged");
  return state.release;
}
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function setup() {
  const root = mkdtempSync(join(tmpdir(), "openmapx-release-io-fixture-"));
  roots.push(root);
  mkdirSync(join(root, "bin"));
  for (const command of ["gh", "docker", "trivy"]) {
    const path = join(root, "bin", command);
    copyFileSync(resolve(import.meta.dirname, "fixtures/product-release-command.mjs"), path);
    chmodSync(path, 0o755);
  }
  const input = fixture();
  const statePath = join(root, "state.json");
  const initial = {
    input,
    latestAttempt: 2,
    release: null,
    registry: {
      [`ghcr.io/openmapx/release-manifest:${input.producerManifest.release}`]:
        input.producerManifestDigest,
    },
    manifests: { [input.producerManifestDigest]: input.producerManifest },
    calls: [],
    published: 0,
  };
  writeFileSync(statePath, JSON.stringify(initial));
  const read = (): SyntheticState => JSON.parse(readFileSync(statePath, "utf8"));
  const update = (fn: (state: SyntheticState) => void) => {
    const state = read();
    fn(state);
    writeFileSync(statePath, JSON.stringify(state));
  };
  const probe = join(root, "probe.mjs");
  const invoke = (code: string) => {
    writeFileSync(
      probe,
      `import {createReleasePorts} from ${JSON.stringify(resolve(import.meta.dirname, "product-release-io.mjs"))};import {prepareProductRelease,inspectPublication,publishProductRelease} from ${JSON.stringify(resolve(import.meta.dirname, "product-release.mjs"))}; const ports=createReleasePorts(); console.log(JSON.stringify(await (async()=>{${code}})()));`,
    );
    return JSON.parse(
      execFileSync(process.execPath, [probe], {
        encoding: "utf8",
        stdio: "pipe",
        env: {
          ...process.env,
          PATH: `${join(root, "bin")}:${process.env.PATH}`,
          SYNTHETIC_STATE: statePath,
          GITHUB_REPOSITORY: input.repository,
          GITHUB_REF: "refs/heads/main",
        },
      }),
    );
  };
  const candidate = planProductRelease(input);
  const prepare = () => invoke("return prepareProductRelease({sourceRunId:123},ports)");
  const inspect = () =>
    invoke(
      `return inspectPublication(${JSON.stringify({ version: candidate.version, expectedCandidateHash: candidateHash(candidate) })},ports)`,
    );
  const stage = () => {
    prepare();
    update((state) => {
      releaseOf(state).assets["readiness.json"] = JSON.stringify({
        schemaVersion: 1,
        candidateHash: candidateHash(candidate),
        candidateManifestDigest: `sha256:${"e".repeat(64)}`,
        environment: "synthetic",
        platform: "linux/amd64",
        testedAt: "2026-10-18T10:00:00Z",
        upgradeOrigin: "prebaseline",
        checks: Object.fromEntries(
          readinessChecks.map((name: string) => [
            name,
            { passed: true, evidence: `https://example.invalid/${name}` },
          ]),
        ),
        limitations: ["synthetic"],
        immutableReleases: {
          enabled: true,
          repository: input.repository,
          candidateHash: candidateHash(candidate),
          checkedBy: "synthetic-owner",
          checkedAt: "2026-10-18T10:00:00Z",
          evidence: "https://example.invalid/settings",
        },
      });
    });
    return inspect();
  };
  const publish = (approved: Record<string, unknown>) =>
    invoke(
      `return publishProductRelease(${JSON.stringify({ ...approved, expectedCandidateHash: candidateHash(candidate) })},ports)`,
    );
  return { read, update, invoke, prepare, inspect, stage, publish, candidate };
}
it("creates, uploads, discovers and retries a tagless draft by exact release ID", () => {
  const t = setup();
  const result = t.prepare();
  expect(result.draftId).toBe(42);
  expect(t.read().tag).toBeUndefined();
  expect(releaseOf(t.read()).assets["candidate.json"]).toBeTruthy();
  expect(t.prepare()).toEqual(result);
  expect(
    t
      .read()
      .calls.filter(
        (call: ExternalCall) => call.args.includes("POST") && call.args[1].endsWith("/releases"),
      ),
  ).toHaveLength(1);
});
it.each([403, 404])("does not reinterpret HTTP %s as an absent draft", (authError) => {
  const t = setup();
  t.update((s) => {
    s.authError = authError;
  });
  expect(() => t.prepare()).toThrow();
  expect(t.read().release).toBeNull();
  expect(t.read().calls.some((c: ExternalCall) => c.args.includes("POST"))).toBe(false);
});
it("pins producer attempt and frozen receipt after a newer attempt fails", () => {
  const t = setup();
  const approved = t.stage();
  t.update((s) => {
    s.latestAttempt = 3;
    delete s.registry[`ghcr.io/openmapx/release-manifest:${s.input.producerManifest.release}`];
  });
  expect(t.inspect().approvalHash).toBe(approved.approvalHash);
  expect(t.publish(approved).published).toBe(true);
  expect(t.read().calls.some((c: ExternalCall) => c.args[1]?.includes("attempts/2/jobs"))).toBe(
    true,
  );
});
it.each(
  ["scan", "tag"].flatMap((point) =>
    ["body", "name", "readiness.json"].map((field) => ({ point, field })),
  ),
)("refuses $field mutation during $point before GitHub publication", ({ point, field }) => {
  const t = setup();
  const approved = t.stage();
  t.update((s) => {
    s.mutation = { point, field };
  });
  expect(() => t.publish(approved)).toThrow();
  expect(t.read().published).toBe(0);
  expect(t.read().registry["ghcr.io/openmapx/release-manifest:preview"]).toBeUndefined();
});
it.each(
  ["changed", "deleted"].flatMap((mode) =>
    ["api", "release-manifest"].map((image) => ({ mode, image })),
  ),
)("does not repair a $mode published $image alias on retry", ({ mode, image }) => {
  const t = setup();
  const approved = t.stage();
  t.update((s) => {
    s.previewFailure = true;
  });
  expect(() => t.publish(approved)).toThrow();
  expect(t.read().published).toBe(1);
  t.update((s) => {
    s.previewFailure = false;
    const ref = `ghcr.io/openmapx/${image}:v0.1.0-alpha.1`;
    if (mode === "deleted") delete s.registry[ref];
    else s.registry[ref] = `sha256:${"f".repeat(64)}`;
  });
  expect(() => t.publish(approved)).toThrow();
  expect(t.read().registry["ghcr.io/openmapx/release-manifest:preview"]).toBeUndefined();
});
it("hands mismatched workflow mutations to existing owner authority and resumes verification", () => {
  const t = setup();
  t.update((s) => {
    s.parityMismatch = true;
  });
  const prepare = t.prepare();
  expect(prepare.status).toBe("owner-action-required");
  expect(t.read().release).toBeNull();
  expect(prepare.handoff.request.body.target_commitish).toBe(t.candidate.sourceRevision);
  t.update((s) => {
    const b = prepare.handoff.request.body;
    s.release = {
      id: 42,
      html_url: "https://example.invalid/draft/42",
      tag_name: b.tag_name,
      target_commitish: b.target_commitish,
      name: b.name,
      body: b.body,
      draft: true,
      prerelease: true,
      assets: {},
    };
  });
  const approved = t.stage();
  const publish = t.publish(approved);
  expect(publish.status).toBe("owner-action-required");
  expect(publish.handoff.approvalHash).toBe(approved.approvalHash);
  expect(publish.handoff.request.path).toBe("repos/OpenMapX/openmapx/releases/42");
  expect(t.read().published).toBe(0);
  expect(t.read().registry["ghcr.io/openmapx/release-manifest:preview"]).toBeUndefined();
  t.update((s) => {
    releaseOf(s).draft = false;
    releaseOf(s).immutable = true;
    s.tag = releaseOf(s).target_commitish;
    s.published++;
  });
  expect(t.publish(approved).previewAdvanced).toBe(true);
  expect(t.read().calls.some((c: ExternalCall) => c.args.includes("PATCH"))).toBe(false);
});

it("does not create a Git tag during read-only discovery", () => {
  const t = setup();
  expect(
    t.invoke(
      `await ports.verifyTagTarget('v0.1.0-alpha.1','${"a".repeat(40)}','check');return true`,
    ),
  ).toBe(true);
  expect(t.read().tag).toBeUndefined();
  expect(() =>
    t.invoke(
      `await ports.verifyTagTarget('v0.1.0-alpha.1','${"a".repeat(40)}','require');return true`,
    ),
  ).toThrow();
  t.invoke(
    `await ports.verifyTagTarget('v0.1.0-alpha.1','${"a".repeat(40)}','create');return true`,
  );
  expect(t.read().tag).toBe("a".repeat(40));
});
