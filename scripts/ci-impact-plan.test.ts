import { describe, expect, it } from "vitest";
import { createImpactPlan, verifyMetadataResults, verifyResults } from "./ci-impact-plan.mjs";

const sha = "a".repeat(40);
const base = "b".repeat(40);
const pr = (paths: string[], extra = {}) =>
  createImpactPlan({
    event: "pull_request",
    action: "synchronize",
    head: sha,
    base,
    paths,
    validationSource: {
      version: 1,
      head: sha,
      runId: 100,
      attempt: 1,
      workflowId: 55,
      target: "c".repeat(64),
      pullRequest: 12,
    },
    metadataGateReady: true,
    metadataEditKnown: true,
    approvedScopes: ["docs", "web", "mobile"],
    ...extra,
  });

describe("CI applicability and required result enforcement", () => {
  it("records proposed leaf selections while retaining full coverage until approval", () => {
    const plan = pr(["docs/docs/page.md"], { approvedScopes: [] });
    expect(plan.proposedScope).toBe("docs");
    expect(plan.scope).toBe("full");
    expect(Object.values(plan.jobs).every(Boolean)).toBe(true);
    expect(pr(["apps/mobile/src/example.ts"], { approvedScopes: ["docs"] }).scope).toBe("full");
    expect(pr(["docs/docs/page.md"], { approvedScopes: ["docs"] }).scope).toBe("docs");
  });
  it("keeps metadata-only edits off the code gate after trusted metadata rollout", () => {
    expect(pr(["packages/core/src/index.ts"], { action: "edited" }).code).toBe(false);
    expect(pr([], { action: "edited", metadataGateReady: false }).code).toBe(true);
    expect(pr([], { action: "edited", baseChanged: true }).code).toBe(true);
  });
  it("runs full validation when metadata has no successful reusable code proof", () => {
    for (const validationSource of [null, {}, { version: 1, head: "c".repeat(40) }]) {
      const plan = pr(["docs/docs/page.md"], { action: "edited", validationSource });
      expect(plan.code).toBe(true);
      expect(Object.values(plan.jobs).every(Boolean)).toBe(true);
    }
  });
  it("selects only docs validation for ordinary site prose", () => {
    const plan = pr(["docs/docs/developer/development-setup.md"]);
    expect(plan.jobs).toEqual({
      lint: true,
      types: false,
      "test-node": true,
      "test-linux-user": false,
      "test-agent-mounts": false,
      "test-web": false,
      mobile: false,
      database: false,
      build: false,
    });
  });
  it.each([
    "docs/Dockerfile",
    "docs/package.json",
    "docs/src/theme/index.tsx",
    "packages/core/src/index.ts",
    ".github/workflows/ci.yml",
    "pnpm-lock.yaml",
    "apps/api/src/db/migrations/007.sql",
    "new-package/code.ts",
    "docs/docs/../src/theme.ts",
  ])("fails closed to complete validation for %s", (path) => {
    expect(Object.values(pr([path]).jobs).every(Boolean)).toBe(true);
  });
  it("keeps node contract tests for a web component but avoids unrelated native recovery", () => {
    const plan = pr(["apps/web/src/components/example.tsx"]);
    expect(plan.jobs["test-node"]).toBe(true);
    expect(plan.jobs["test-web"]).toBe(true);
    expect(plan.jobs.database).toBe(false);
    expect(plan.jobs.mobile).toBe(false);
  });
  it("retains mobile and node contracts for mobile runtime-only changes", () => {
    const plan = pr(["apps/mobile/src/example.ts"]);
    expect(plan.jobs.mobile).toBe(true);
    expect(plan.jobs["test-node"]).toBe(true);
    expect(plan.jobs.database).toBe(false);
    expect(plan.jobs["test-web"]).toBe(false);
  });
  it("never narrows trusted main reconciliation or incomplete diffs", () => {
    expect(Object.values(pr([], { event: "schedule" }).jobs).every(Boolean)).toBe(true);
    expect(Object.values(pr([]).jobs).every(Boolean)).toBe(true);
    expect(
      Object.values(pr(["docs/docs/a.md"], { pathsComplete: false }).jobs).every(Boolean),
    ).toBe(true);
  });
  it("handles complete diffs beyond GitHub's 300-file path-filter limit", () => {
    const paths = Array.from({ length: 350 }, (_, n) => `docs/docs/page-${n}.md`);
    expect(pr(paths).jobs.database).toBe(false);
    expect(pr([...paths, "packages/core/src/last.ts"]).jobs.database).toBe(true);
  });
  it("requires positive success for selected jobs and exact skip for unselected jobs", () => {
    const plan = pr(["docs/docs/page.md"]);
    const results = Object.fromEntries(
      Object.entries(plan.jobs).map(([id, selected]) => [
        id,
        { result: selected ? "success" : "skipped" },
      ]),
    );
    results["docker-changes"] = { result: "success", outputs: { apps: '["docs"]' } } as never;
    results["docker-build"] = { result: "success" };
    expect(() => verifyResults(plan, results, "pull_request")).not.toThrow();
    for (const result of ["failure", "cancelled", "skipped", undefined]) {
      expect(() => verifyResults(plan, { ...results, lint: { result } }, "pull_request")).toThrow();
    }
    expect(() =>
      verifyResults(plan, { ...results, database: { result: "success" } }, "pull_request"),
    ).toThrow();
    expect(() => verifyResults({ ...plan, version: 0 }, results, "pull_request")).toThrow();
  });
  it("keeps hidden docs/node and web/mobile boundary readers selected", () => {
    expect(pr(["docs/docs/features/personal-timeline.md"]).jobs["test-node"]).toBe(true);
    for (const path of ["map/HostMapProvider.tsx", "search/VoiceSearchButton.tsx"]) {
      expect(pr([`apps/web/src/components/${path}`]).jobs.mobile).toBe(true);
    }
  });
  it("rejects aggregate dependencies absent from the selection contract", () => {
    const plan = pr(["packages/core/src/index.ts"]);
    const needs = {
      ...Object.fromEntries(Object.keys(plan.jobs).map((id) => [id, { result: "success" }])),
      "docker-changes": { result: "success", outputs: { apps: "[]" } },
      "docker-build": { result: "skipped" },
      future: { result: "failure" },
    };
    expect(() => verifyResults(plan, needs, "pull_request")).toThrow(/unknown/i);
  });
  it("rejects malformed immutable source identities", () => {
    expect(() => pr(["docs/docs/a.md"], { head: "main" })).toThrow();
  });
});

describe("CI selector fail-closed boundaries", () => {
  it("runs the full gate for a base retarget or an unknown event action", () => {
    expect(
      Object.values(pr(["docs/docs/a.md"], { baseChanged: true, action: "edited" }).jobs).every(
        Boolean,
      ),
    ).toBe(true);
    expect(Object.values(pr(["docs/docs/a.md"], { action: "unknown" }).jobs).every(Boolean)).toBe(
      true,
    );
  });
  it("cannot turn trusted main into a selectively skipped gate using a malformed receipt", () => {
    const plan = createImpactPlan({ event: "push", head: sha, paths: [] });
    const needs = Object.fromEntries(
      Object.keys(plan.jobs).map((id) => [id, { result: "success" }]),
    );
    needs["docker-changes"] = { result: "skipped" };
    needs["docker-build"] = { result: "skipped" };
    expect(() =>
      verifyResults(
        { ...plan, jobs: { ...plan.jobs, database: false } },
        { ...needs, database: { result: "skipped" } },
        "push",
      ),
    ).toThrow();
  });
});

it("does not let a rerun of superseded main cancel current validation", () => {
  expect(createImpactPlan({ event: "push", head: sha, paths: [], mainCurrent: false }).code).toBe(
    false,
  );
});

describe("executing metadata gate", () => {
  it("requires valid source proof and exact skipped dependencies instead of a green no-op", () => {
    const plan = pr(["packages/core/src/index.ts"], { action: "edited" });
    const needs = Object.fromEntries(
      ["select", ...Object.keys(plan.jobs), "docker-changes", "docker-build"].map((id) => [
        id,
        { result: id === "select" ? "success" : "skipped" },
      ]),
    );
    expect(() => verifyMetadataResults(plan, needs)).not.toThrow();
    expect(() => verifyMetadataResults({ ...plan, validationSource: null }, needs)).toThrow();
    for (const result of ["failure", "cancelled", "success", undefined])
      expect(() => verifyMetadataResults(plan, { ...needs, lint: { result } })).toThrow();
    expect(() =>
      verifyMetadataResults(plan, { ...needs, select: { result: "failure" } }),
    ).toThrow();
    expect(() =>
      verifyMetadataResults(plan, { ...needs, unknown: { result: "skipped" } }),
    ).toThrow();
  });
});
