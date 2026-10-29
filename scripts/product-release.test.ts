import { describe, expect, it } from "vitest";
import { parseReleaseComposeSelection } from "../packages/core/src/services/release-manifest";
import { fixture } from "./product-release.fixtures";
import {
  inspectPublication,
  prepareProductRelease,
  publishProductRelease,
} from "./product-release.mjs";
import {
  candidateHash,
  planProductRelease,
  readinessChecks,
  sha256,
} from "./product-release-plan.mjs";

type Draft = {
  id?: number;
  version: string;
  target: string;
  name?: string;
  body?: string;
  draft: boolean;
  prerelease: boolean;
  immutable?: boolean;
  assets: Record<string, string>;
};
function setup() {
  const input = fixture();
  const candidate = planProductRelease(input);
  const digest = `sha256:${"e".repeat(64)}`;
  const state: {
    draft: Draft;
    preview: { version: string; digest: string } | null;
    tags: Map<string, string>;
    fail: string;
    scans: number;
    published: number;
  } = {
    draft: { version: "", target: "", draft: true, prerelease: true, assets: {} },
    preview: null,
    tags: new Map(),
    fail: "",
    scans: 0,
    published: 0,
  };
  const fail = (point: string) => {
    if (state.fail === point) throw new Error(`interrupted ${point}`);
  };
  const ports = {
    async verifyEnvironment() {
      fail("environment");
    },
    repository: input.repository,
    ref: "refs/heads/main",
    async producer() {
      return input;
    },
    async packageManifest(manifest: unknown) {
      expect(manifest).toEqual(candidate.manifest);
      return digest;
    },
    async extractManifest(actual: string) {
      expect(actual).toBe(digest);
      return candidate.manifest;
    },
    async draft() {
      return state.draft.version ? structuredClone(state.draft) : null;
    },
    async writeDraft(value: Draft) {
      fail("draft");
      state.draft = {
        ...structuredClone(value),
        id: 42,
        name: value.version,
        body: value.assets["notes.md"],
      };
      return state.draft;
    },
    async scan() {
      fail("scan");
      state.scans++;
    },
    async mutationAuthority() {
      return { automated: true };
    },
    async requireAlias(reference: string, value: string) {
      if (state.tags.get(reference) !== value) throw new Error("Published alias changed");
    },
    async tag(reference: string, value: string) {
      fail(reference);
      const previous = state.tags.get(reference);
      if (previous && previous !== value) throw new Error("conflict");
      state.tags.set(reference, value);
    },
    async preview() {
      return state.preview;
    },
    async advancePreview(value: { version: string; digest: string }) {
      fail("preview");
      state.preview = structuredClone(value);
    },
    async publish() {
      fail("publish");
      state.draft.draft = false;
      state.draft.immutable = true;
      state.published++;
    },
    async verifyPublished() {
      fail("attestation");
      expect(state.draft.immutable).toBe(true);
    },
    async verifyTagTarget() {
      fail("tag-target");
    },
  };
  const readiness = () => ({
    schemaVersion: 1,
    candidateHash: candidateHash(candidate),
    candidateManifestDigest: digest,
    environment: "synthetic fixture only",
    platform: "linux/amd64",
    testedAt: "2026-10-18T10:00:00Z",
    upgradeOrigin: "prebaseline",
    checks: Object.fromEntries(
      readinessChecks.map((name: string) => [
        name,
        { passed: true, evidence: `https://example.invalid/synthetic/${name}` },
      ]),
    ),
    limitations: ["Synthetic; no runtime acceptance"],
    immutableReleases: {
      enabled: true,
      repository: input.repository,
      candidateHash: candidateHash(candidate),
      checkedBy: "synthetic-owner",
      checkedAt: "2026-10-18T10:00:00Z",
      evidence: "https://example.invalid/synthetic/settings",
    },
  });
  const stage = async () => {
    await prepareProductRelease({ sourceRunId: 123 }, ports);
    state.draft.assets["readiness.json"] = JSON.stringify(readiness());
    return inspectPublication(
      { version: candidate.version, expectedCandidateHash: candidateHash(candidate) },
      ports,
    );
  };
  return { candidate, digest, state, ports, stage };
}
describe("publication state machine (synthetic registries only)", () => {
  it("stages durable assets without moving discovery or final tags", async () => {
    const t = setup();
    await t.stage();
    expect(t.state.preview).toBeNull();
    expect(t.state.tags.size).toBe(0);
    expect(t.state.draft.assets.SHA256SUMS).toContain("candidate.json");
    expect(t.state.draft.target).toBe(t.candidate.sourceRevision);
  });
  it("publishes exact content then advances preview and retries without changing assets", async () => {
    const t = setup();
    const approved = await t.stage();
    await publishProductRelease(
      { ...approved, expectedCandidateHash: candidateHash(t.candidate) },
      t.ports,
    );
    const assets = structuredClone(t.state.draft.assets);
    expect(t.state.preview).toEqual({ version: t.candidate.version, digest: t.digest });
    expect(t.state.tags.size).toBe(8);
    await publishProductRelease(
      { ...approved, expectedCandidateHash: candidateHash(t.candidate) },
      t.ports,
    );
    expect(t.state.draft.assets).toEqual(assets);
    expect(t.state.published).toBe(1);
  });
  it.each([
    "environment",
    "scan",
    "tag-target",
    "ghcr.io/openmapx/ops-agent:v0.1.0-alpha.1",
    "publish",
    "attestation",
    "preview",
  ])("keeps preview unchanged on interrupted %s and resumes identically", async (point) => {
    const t = setup();
    const approved = await t.stage();
    t.state.fail = point;
    await expect(
      publishProductRelease(
        { ...approved, expectedCandidateHash: candidateHash(t.candidate) },
        t.ports,
      ),
    ).rejects.toThrow();
    expect(t.state.preview).toBeNull();
    t.state.fail = "";
    await publishProductRelease(
      { ...approved, expectedCandidateHash: candidateHash(t.candidate) },
      t.ports,
    );
    expect(t.state.preview.digest).toBe(t.digest);
  });
  it("does not downgrade a newer preview during an older retry", async () => {
    const t = setup();
    const approved = await t.stage();
    t.state.preview = { version: "v0.1.0-alpha.2", digest: `sha256:${"f".repeat(64)}` };
    await publishProductRelease(
      { ...approved, expectedCandidateHash: candidateHash(t.candidate) },
      t.ports,
    );
    expect(t.state.preview.version).toBe("v0.1.0-alpha.2");
  });
  it.each(["candidate.json", "release-manifest.json", "readiness.json", "notes.md", "SHA256SUMS"])(
    "rejects %s mutation while approval is paused",
    async (name) => {
      const t = setup();
      const approved = await t.stage();
      t.state.draft.assets[name] += "mutated";
      await expect(
        publishProductRelease(
          { ...approved, expectedCandidateHash: candidateHash(t.candidate) },
          t.ports,
        ),
      ).rejects.toThrow();
      expect(t.state.tags.size).toBe(0);
    },
  );
  it("requires rehearsal evidence and main orchestration", async () => {
    const t = setup();
    await prepareProductRelease({ sourceRunId: 123 }, t.ports);
    await expect(
      inspectPublication(
        { version: t.candidate.version, expectedCandidateHash: candidateHash(t.candidate) },
        t.ports,
      ),
    ).rejects.toThrow();
    t.ports.ref = "refs/heads/feature";
    await expect(t.stage()).rejects.toThrow(/main/);
  });
  it("rejects a conflicting image tag without advancing preview", async () => {
    const t = setup();
    const approved = await t.stage();
    t.state.tags.set("ghcr.io/openmapx/api:v0.1.0-alpha.1", `sha256:${"f".repeat(64)}`);
    await expect(
      publishProductRelease(
        { ...approved, expectedCandidateHash: candidateHash(t.candidate) },
        t.ports,
      ),
    ).rejects.toThrow(/conflict/);
    expect(t.state.preview).toBeNull();
  });
});

it.each([
  "settings-disabled",
  "wrong-upgrade-origin",
  "bad-date",
  "missing-check",
  "missing-artifact",
])("blocks incomplete readiness or artifact identity: %s", async (problem) => {
  const t = setup();
  await t.stage();
  const readiness = JSON.parse(t.state.draft.assets["readiness.json"]);
  if (problem === "settings-disabled") readiness.immutableReleases.enabled = false;
  if (problem === "wrong-upgrade-origin") readiness.upgradeOrigin = "invented-stable";
  if (problem === "bad-date") readiness.testedAt = "2026";
  if (problem === "missing-check") delete readiness.checks.privacyEvidence;
  if (problem === "missing-artifact")
    t.ports.extractManifest = async () => {
      throw new Error("synthetic missing artifact");
    };
  t.state.draft.assets["readiness.json"] = JSON.stringify(readiness);
  await expect(
    inspectPublication(
      { version: t.candidate.version, expectedCandidateHash: candidateHash(t.candidate) },
      t.ports,
    ),
  ).rejects.toThrow();
  expect(t.state.tags.size).toBe(0);
  expect(t.state.preview).toBeNull();
});

it("provides an auditable usable overlay and exact evidence links before publishing approval", async () => {
  const t = setup();
  const review = await t.stage();
  expect(
    parseReleaseComposeSelection(t.state.draft.assets["docker-compose.release.yml"]),
  ).toMatchObject({ release: t.candidate.version, images: t.candidate.manifest.images });
  expect(review.readiness.checks.cleanInstall.evidence).toBe(
    "https://example.invalid/synthetic/cleanInstall",
  );
  expect(review.assets["readiness.json"]).toBe(sha256(t.state.draft.assets["readiness.json"]));
});

it("reconciles a lost registry acknowledgement after the final preview write", async () => {
  const t = setup();
  const approved = await t.stage();
  const advance = t.ports.advancePreview;
  t.ports.advancePreview = async (selection) => {
    await advance(selection);
    throw new Error("synthetic lost acknowledgement after commit");
  };
  await expect(
    publishProductRelease(
      { ...approved, expectedCandidateHash: candidateHash(t.candidate) },
      t.ports,
    ),
  ).rejects.toThrow(/lost acknowledgement/);
  expect(t.state.preview).toEqual({ version: t.candidate.version, digest: t.digest });
  expect(t.state.published).toBe(1);
  t.ports.advancePreview = advance;
  await expect(
    publishProductRelease(
      { ...approved, expectedCandidateHash: candidateHash(t.candidate) },
      t.ports,
    ),
  ).resolves.toEqual({ published: true, previewAdvanced: false });
  expect(t.state.published).toBe(1);
});

it("requires every published version alias without repairing missing or changed bytes", async () => {
  for (const image of [
    "api",
    "web",
    "data-manager",
    "ops-agent",
    "privacy-backup",
    "transitous-runner",
    "transitous-tools",
    "release-manifest",
  ]) {
    for (const mutation of ["missing", "changed"]) {
      const t = setup();
      const approved = await t.stage();
      t.state.fail = "preview";
      await expect(
        publishProductRelease(
          { ...approved, expectedCandidateHash: candidateHash(t.candidate) },
          t.ports,
        ),
      ).rejects.toThrow();
      expect(t.state.published).toBe(1);
      t.state.fail = "";
      const reference = `ghcr.io/openmapx/${image}:${t.candidate.version}`;
      if (mutation === "missing") t.state.tags.delete(reference);
      else t.state.tags.set(reference, `sha256:${"f".repeat(64)}`);
      await expect(
        publishProductRelease(
          { ...approved, expectedCandidateHash: candidateHash(t.candidate) },
          t.ports,
        ),
      ).rejects.toThrow("Published alias changed");
      expect(t.state.preview).toBeNull();
      expect(t.state.tags.get(reference)).toBe(
        mutation === "missing" ? undefined : `sha256:${"f".repeat(64)}`,
      );
    }
  }
});
