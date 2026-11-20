import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  createImpactPlan,
  mergeQueueDatabaseGroups,
  plannedDatabaseMatrix,
  scopeSkippedJobs,
  selectiveScopes,
  validationJobs,
  verifyMergeQueueResults,
  verifyMetadataResults,
  verifyResults,
} from "./ci-impact-plan.mjs";

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
    approvedScopes: ["docs", "web", "mobile", "client"],
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
      "test-agent-image": false,
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
  it("runs client source, translations and docs prose without the database and host jobs", () => {
    const skipped = ["database", "test-linux-user", "test-agent-image"];
    for (const paths of [
      ["apps/web/src/lib/navigation/useNavigationVoice.ts", "apps/web/src/app/page.tsx"],
      ["apps/web/src/components/search/VoiceSearchButton.tsx"],
      ["apps/web/src/components/example.tsx", "packages/i18n/locales/de.json"],
      ["apps/web/src/styles/global.css", "docs/docs/features/search.md"],
      ["apps/mobile/src/example.ts", "apps/web/src/components/example.tsx"],
      ["packages/i18n/locales/en.json"],
    ]) {
      const plan = pr(paths);
      expect(plan.scope, paths.join()).toBe("client");
      for (const id of validationJobs) expect(plan.jobs[id], id).toBe(!skipped.includes(id));
    }
  });
  it.each([
    "apps/web/package.json",
    "apps/web/next.config.ts",
    "apps/web/public/runtime/importmap.json",
    "apps/web/scripts/build-runtime-modules.mjs",
    "apps/mobile/package.json",
    "apps/mobile/app.config.ts",
    "packages/i18n/index.ts",
    "packages/i18n/locales/nested/de.json",
    "packages/core/src/index.ts",
    "apps/api/src/privacy/notifications.ts",
    "integrations/fuel/FuelLayer.tsx",
  ])("runs every job when client source arrives with %s", (path) => {
    const plan = pr(["apps/web/src/components/example.tsx", path]);
    expect(plan.scope).toBe("full");
    expect(Object.values(plan.jobs).every(Boolean)).toBe(true);
  });
  it("keeps the client scope in shadow mode until trusted main approves it", () => {
    const plan = pr(["apps/web/src/lib/example.ts"], { approvedScopes: ["docs", "web", "mobile"] });
    expect(plan.proposedScope).toBe("client");
    expect(plan.scope).toBe("full");
    expect(Object.values(plan.jobs).every(Boolean)).toBe(true);
  });
  it("accepts a client run only with the database and host jobs skipped", () => {
    const plan = pr(["apps/web/src/lib/example.ts"]);
    const results = Object.fromEntries(
      Object.entries(plan.jobs).map(([id, selected]) => [
        id,
        { result: selected ? "success" : "skipped" },
      ]),
    );
    results["docker-changes"] = { result: "success", outputs: { apps: '["web"]' } } as never;
    results["docker-build"] = { result: "success" };
    expect(() => verifyResults(plan, results, "pull_request")).not.toThrow();
    expect(() =>
      verifyResults(plan, { ...results, database: { result: "success" } }, "pull_request"),
    ).toThrow();
    expect(() =>
      verifyResults(plan, { ...results, mobile: { result: "skipped" } }, "pull_request"),
    ).toThrow();
    expect(() => verifyResults({ ...plan, scope: "docs" }, results, "pull_request")).toThrow(
      /declared scope/,
    );
    expect(() => verifyResults({ ...plan, scope: "other" }, results, "pull_request")).toThrow();
  });
  it("never lets a scope skip lint, the portable node tests or an unknown job", () => {
    expect(selectiveScopes).toEqual(["docs", "web", "mobile", "client"]);
    for (const scope of selectiveScopes) {
      expect(scopeSkippedJobs[scope].length, scope).toBeGreaterThan(0);
      expect(scopeSkippedJobs[scope], scope).not.toContain("lint");
      expect(scopeSkippedJobs[scope], scope).not.toContain("test-node");
      for (const id of scopeSkippedJobs[scope]) expect(validationJobs, scope).toContain(id);
    }
    for (const scope of ["web", "mobile", "client"])
      for (const id of ["types", "build"]) expect(scopeSkippedJobs[scope]).not.toContain(id);
  });
  it("approves only scopes the selector knows on trusted main", () => {
    const rollout = JSON.parse(
      readFileSync(new URL("./ci-impact-rollout.json", import.meta.url), "utf8"),
    );
    expect(rollout.version).toBe(1);
    expect(rollout.approvedScopes).toEqual(["docs", "web", "mobile", "client"]);
    for (const scope of rollout.approvedScopes) expect(selectiveScopes).toContain(scope);
    expect(rollout.mergeQueueDatabaseGroups).toEqual(mergeQueueDatabaseGroups);
  });
  it("leaves approved database groups to the merge queue on pull requests only", () => {
    const matrix = [
      { group: "api-privacy", part: 1, total: 1 },
      { group: "crash-points", part: 1, total: 2 },
      { group: "crash-points", part: 2, total: 2 },
      { group: "coordinator-recovery", part: 1, total: 1 },
    ];
    const approved = { approvedMergeQueueGroups: ["crash-points", "coordinator-recovery"] };
    const plan = pr(["packages/core/src/index.ts"], approved);
    expect(plan.deferredDatabaseGroups).toEqual(["coordinator-recovery", "crash-points"]);
    expect(plannedDatabaseMatrix(plan, matrix)).toEqual([matrix[0]]);
    // Without approval on the default branch a pull request runs every group.
    const unapproved = pr(["packages/core/src/index.ts"]);
    expect(unapproved.deferredDatabaseGroups).toEqual([]);
    expect(plannedDatabaseMatrix(unapproved, matrix)).toEqual(matrix);
    // The merge queue, main and the schedule are never narrowed.
    for (const event of ["merge_group", "push", "schedule", "workflow_dispatch"]) {
      const complete = pr(["packages/core/src/index.ts"], { ...approved, event });
      expect(complete.scope, event).toBe("full");
      expect(complete.deferredDatabaseGroups, event).toEqual([]);
      expect(plannedDatabaseMatrix(complete, matrix), event).toEqual(matrix);
    }
    // A scope that already skips the database job defers nothing.
    expect(pr(["docs/docs/page.md"], approved).deferredDatabaseGroups).toEqual([]);
    // Unknown or repeated groups approve nothing.
    for (const approvedMergeQueueGroups of [["api-privacy"], ["crash-points", "crash-points"], {}])
      expect(
        pr(["packages/core/src/index.ts"], { approvedMergeQueueGroups }).deferredDatabaseGroups,
      ).toEqual([]);
  });
  it("rejects a deferral outside a pull request or of a group that must always run", () => {
    const results = (plan: ReturnType<typeof pr>) => ({
      ...Object.fromEntries(
        Object.entries(plan.jobs).map(([id, selected]) => [
          id,
          { result: selected ? "success" : "skipped" },
        ]),
      ),
      "docker-changes": { result: "success", outputs: { apps: "[]" } },
      "docker-build": { result: "skipped" },
    });
    const plan = pr(["packages/core/src/index.ts"], {
      approvedMergeQueueGroups: ["crash-points"],
    });
    expect(() => verifyResults(plan, results(plan), "pull_request")).not.toThrow();
    for (const deferredDatabaseGroups of [["api-privacy"], ["crash-points", "crash-points"], null])
      expect(() =>
        verifyResults({ ...plan, deferredDatabaseGroups }, results(plan), "pull_request"),
      ).toThrow(/deferred database groups/);
    expect(() =>
      plannedDatabaseMatrix({ ...plan, deferredDatabaseGroups: ["api-privacy"] }),
    ).toThrow();
    const queued = pr(["packages/core/src/index.ts"], { event: "merge_group" });
    const queuedResults = {
      ...results(queued),
      "docker-changes": { result: "skipped" },
      "docker-build": { result: "skipped" },
    };
    expect(() => verifyResults(queued, queuedResults, "merge_group")).not.toThrow();
    expect(() =>
      verifyResults(
        { ...queued, deferredDatabaseGroups: ["crash-points"] },
        queuedResults,
        "merge_group",
      ),
    ).toThrow(/merge queue/);
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
    expect(pr(["apps/web/src/components/search/VoiceSearchButton.tsx"]).jobs.mobile).toBe(true);
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

describe("main push reusing the merge queue's validation", () => {
  const mergeQueueSource = { version: 1, runId: 900, attempt: 1, workflowId: 55, head: sha };
  const push = (extra = {}) =>
    createImpactPlan({
      event: "push",
      action: undefined,
      head: sha,
      base: "",
      paths: [],
      mergeQueueSource,
      ...extra,
    });
  const skipped = (plan: ReturnType<typeof push>) =>
    Object.fromEntries(
      ["select", ...Object.keys(plan.jobs), "docker-changes", "docker-build"].map((id) => [
        id,
        { result: id === "select" ? "success" : "skipped" },
      ]),
    );

  it("skips validation for a current main commit the merge queue validated", () => {
    const plan = push();
    expect(plan.code).toBe(false);
    expect(plan.reason).toBe("merge-queue-validated");
    expect(plan.scope).toBe("full");
    expect(plan.validationSource).toEqual(mergeQueueSource);
    expect(plan.deferredDatabaseGroups).toEqual([]);
  });

  it("validates in full without matching evidence or outside a current main push", () => {
    for (const source of [
      null,
      {},
      { ...mergeQueueSource, head: "c".repeat(40) },
      { ...mergeQueueSource, runId: 0 },
      { ...mergeQueueSource, pullRequest: 12 },
    ]) {
      const plan = push({ mergeQueueSource: source });
      expect(plan.code).toBe(true);
      expect(plan.validationSource).toBeNull();
    }
    for (const event of ["schedule", "workflow_dispatch", "merge_group"])
      expect(push({ event }).code).toBe(true);
    const superseded = push({ mainCurrent: false });
    expect(superseded.reason).toBe("superseded-main");
    expect(superseded.validationSource).toBeNull();
  });

  it("passes the gate only with exactly the skipped dependencies and the receipt", () => {
    const plan = push();
    const needs = skipped(plan);
    expect(() => verifyMergeQueueResults(plan, needs)).not.toThrow();
    expect(() => verifyMergeQueueResults({ ...plan, validationSource: null }, needs)).toThrow();
    expect(() => verifyMergeQueueResults({ ...plan, reason: "metadata-only" }, needs)).toThrow();
    expect(() => verifyMergeQueueResults({ ...plan, event: "schedule" }, needs)).toThrow();
    expect(() => verifyMergeQueueResults({ ...plan, code: true }, needs)).toThrow();
    for (const result of ["failure", "cancelled", "success", undefined])
      expect(() => verifyMergeQueueResults(plan, { ...needs, database: { result } })).toThrow();
    expect(() =>
      verifyMergeQueueResults(plan, { ...needs, select: { result: "failure" } }),
    ).toThrow();
    expect(() =>
      verifyMergeQueueResults(plan, { ...needs, unknown: { result: "skipped" } }),
    ).toThrow();
    // The metadata gate never accepts a merge-queue receipt, nor the reverse.
    expect(() => verifyMetadataResults(plan, needs)).toThrow();
    expect(() => verifyResults(plan, needs, "push")).toThrow();
  });
});
