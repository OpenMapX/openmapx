import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  codeReceipt,
  findMergeQueueValidation,
  findReusableCodeValidation,
  targetDigest,
} from "./ci-code-evidence.mjs";

const head = "a".repeat(40);
const source = { head, number: 790, baseRef: "main", baseRepositoryId: 1171046573 };
const current = {
  id: 300,
  workflow_id: 55,
  event: "pull_request",
  path: ".github/workflows/ci.yml",
  head_sha: head,
  run_attempt: 1,
  run_number: 300,
  run_started_at: "2026-11-07T00:00:00Z",
};
const run = (id: number, extra = {}) => ({
  ...current,
  id,
  run_number: id,
  run_started_at: new Date(Date.UTC(2026, 10, 7, 0, 0, id)).toISOString(),
  status: "completed",
  conclusion: "success",
  ...extra,
});
const receipt = (id: number, code = true, extra = {}) =>
  codeReceipt({ ...source, runId: id, attempt: 1, code, ...extra });
type JobRow = {
  name: string;
  status: string;
  conclusion?: string;
  run_id: number;
  run_attempt: number;
  head_sha: string;
  steps?: { name: string; status: string; conclusion: string }[];
};
const jobs = (id: number, code = true): JobRow[] => [
  {
    name: "select required validation",
    status: "completed",
    conclusion: "success",
    run_id: id,
    run_attempt: 1,
    head_sha: head,
    steps: [
      {
        name: `CI source v1 ${JSON.stringify(receipt(id, code))}`,
        status: "completed",
        conclusion: "success",
      },
    ],
  },
  {
    name: "lint",
    status: "completed",
    conclusion: code ? "success" : "skipped",
    run_id: id,
    run_attempt: 1,
    head_sha: head,
  },
  {
    name: "lint / types / test",
    status: "completed",
    conclusion: "success",
    run_id: id,
    run_attempt: 1,
    head_sha: head,
  },
];
async function find(runs: ReturnType<typeof run>[], rows: Record<number, ReturnType<typeof jobs>>) {
  return findReusableCodeValidation({
    current,
    source,
    runs,
    readJobs: async (id: number) => rows[id],
  });
}
describe("provider-bound code validation reuse", () => {
  it("reuses successful code through newer metadata suites, not their copied gates", async () => {
    const result = await find([run(200), run(100), run(300)], {
      200: jobs(200, false),
      100: jobs(100),
    });
    expect(result?.runId).toBe(100);
    expect(result?.head).toBe(head);
  });
  it("does not mask an unfinished or failed rerun of an older run ID", async () => {
    for (const state of [
      { status: "in_progress", conclusion: null },
      { status: "completed", conclusion: "failure" },
    ]) {
      expect(
        await find(
          [
            run(200),
            run(100, { run_attempt: 2, run_started_at: "2026-11-07T00:10:00Z", ...state }),
          ],
          { 200: jobs(200), 100: jobs(100) },
        ),
      ).toBeNull();
    }
  });
  it("fails closed for ambiguous simultaneous code executions", async () => {
    expect(
      await find(
        [
          run(100, { run_started_at: "2026-11-07T00:00:00Z", conclusion: "failure" }),
          run(200, { run_started_at: "2026-11-07T00:00:00Z" }),
        ],
        { 100: jobs(100), 200: jobs(200) },
      ),
    ).toBeNull();
  });
  it.each(["queued", "in_progress", "failure", "cancelled", "timed_out"])(
    "does not reuse older green over newer %s code",
    async (status) => {
      const newer = run(
        200,
        status === "queued" || status === "in_progress"
          ? { status, conclusion: null }
          : { conclusion: status },
      );
      expect(await find([run(100), newer], { 100: jobs(100), 200: jobs(200) })).toBeNull();
    },
  );
  it.each(["skipped", "failure", "cancelled", undefined])(
    "requires positive aggregate success, not %s",
    async (conclusion) => {
      const rows = jobs(100);
      rows[2].conclusion = conclusion;
      expect(await find([run(100)], { 100: rows })).toBeNull();
    },
  );
  it("fails closed on missing/ambiguous receipts and unknown newer runs", async () => {
    expect(await find([run(200), run(100)], { 200: [], 100: jobs(100) })).toBeNull();
    const rows = jobs(100);
    const steps = rows[0].steps;
    if (!steps) throw Error("Fixture selector must have a source step");
    steps.push({ ...steps[0] });
    expect(await find([run(100)], { 100: rows })).toBeNull();
  });
  it.each([
    { head: "b".repeat(40) },
    { number: 791 },
    { baseRef: "release" },
    { baseRepositoryId: 2 },
    { runId: 99 },
    { attempt: 2 },
  ])("rejects mismatched source provenance %j", async (changed) => {
    const rows = jobs(100);
    const step = rows[0].steps?.[0];
    if (!step) throw Error("Fixture selector must have a source step");
    step.name = `CI source v1 ${JSON.stringify(receipt(100, true, changed))}`;
    expect(await find([run(100)], { 100: rows })).toBeNull();
  });
  it("accepts carried-forward selection only after the new attempt completes successfully", async () => {
    const carried = jobs(100);
    carried[2].run_attempt = 2;
    expect((await find([run(100, { run_attempt: 2 })], { 100: carried }))?.attempt).toBe(2);
    expect(await find([run(100, { run_attempt: 2 })], { 100: jobs(100) })).toBeNull();
    expect(
      await find([run(100, { run_attempt: 2, status: "in_progress", conclusion: null })], {
        100: jobs(100),
      }),
    ).toBeNull();
  });
  it("never treats metadata evidence as code when a validation job actually ran", async () => {
    const rows = jobs(200, false);
    rows[1].conclusion = "failure";
    expect(await find([run(200), run(100)], { 200: rows, 100: jobs(100) })).toBeNull();
  });
  it("cannot bootstrap from the misleading PR790 rollup or a missing legacy binding", async () => {
    const f = JSON.parse(
      readFileSync(new URL("./__fixtures__/required-check-pr790.json", import.meta.url), "utf8"),
    );
    expect(f.requiredStatusEvaluation.details).toContain('"lint / types / test" is expected');
    expect(f.codeJobs.find((j: JobRow) => j.name === "lint / types / test").conclusion).toBe(
      "success",
    );
    expect(f.metadataJobs.some((j: JobRow) => j.name === "lint / types / test")).toBe(false);
    expect(
      await findReusableCodeValidation({
        current: { ...current, workflow_id: f.codeRun.workflow_id, head_sha: f.codeRun.head_sha },
        source: { ...source, head: f.codeRun.head_sha },
        runs: [f.metadataRun, f.codeRun],
        readJobs: async (id: number) => (id === f.codeRun.id ? f.codeJobs : f.metadataJobs),
      }),
    ).toBeNull();
  });
  it("binds base repository/ref while allowing normal base-branch advancement", () => {
    const advancedBase = { ...source, baseSha: "new-main" };
    expect(targetDigest(source)).toBe(targetDigest(advancedBase));
    expect(targetDigest(source)).not.toBe(targetDigest({ ...source, baseRef: "release" }));
  });
});

describe("merge-queue validation reused by the push to main", () => {
  const pushRun = {
    id: 500,
    workflow_id: 55,
    event: "push",
    head_branch: "main",
    path: ".github/workflows/ci.yml",
    head_sha: head,
    run_attempt: 1,
  };
  const queueRun = (id: number, extra = {}) => ({
    id,
    workflow_id: 55,
    event: "merge_group",
    head_branch: `gh-readonly-queue/main/pr-1028-${"b".repeat(40)}`,
    path: ".github/workflows/ci.yml",
    head_sha: head,
    run_attempt: 1,
    run_started_at: new Date(Date.UTC(2026, 10, 17, 0, 0, id)).toISOString(),
    status: "completed",
    conclusion: "success",
    ...extra,
  });
  const queueJobs = (id: number, extra: Partial<JobRow>[] = []): JobRow[] =>
    [
      { name: "select required validation" },
      { name: "test (database, crash-points, 1/4)" },
      { name: "build Docker", conclusion: "skipped" },
      { name: "lint / types / test" },
      ...extra,
    ].map((job) => ({
      status: "completed",
      conclusion: "success",
      run_id: id,
      run_attempt: 1,
      head_sha: head,
      ...job,
    })) as JobRow[];
  const lookup = (
    runs: ReturnType<typeof queueRun>[],
    jobs: Record<number, JobRow[]>,
    current = {},
  ) =>
    findMergeQueueValidation({
      current: { ...pushRun, ...current },
      head,
      runs,
      readJobs: async (id: number) => jobs[id],
    });

  it("reuses the newest entirely green merge-queue run of the same commit", async () => {
    expect(
      await lookup([queueRun(600), queueRun(700)], { 600: queueJobs(600), 700: queueJobs(700) }),
    ).toEqual({
      version: 1,
      runId: 700,
      attempt: 1,
      workflowId: 55,
      head,
    });
  });

  it("falls back to an older green run when the newest is not reusable", async () => {
    const failed = queueJobs(700, [{ name: "build", conclusion: "failure" }]);
    expect(
      (await lookup([queueRun(600), queueRun(700)], { 600: queueJobs(600), 700: failed }))?.runId,
    ).toBe(600);
  });

  it("refuses incomplete, red or foreign runs", async () => {
    const jobs = { 600: queueJobs(600) };
    for (const run of [
      queueRun(600, { status: "in_progress" }),
      queueRun(600, { conclusion: "failure" }),
      queueRun(600, { event: "pull_request" }),
      queueRun(600, { workflow_id: 56 }),
      queueRun(600, { path: ".github/workflows/other.yml" }),
      queueRun(600, { head_sha: "c".repeat(40) }),
      queueRun(600, { head_branch: "gh-readonly-queue/release/pr-1" }),
      queueRun(600, { head_branch: "main" }),
    ])
      expect(await lookup([run], jobs)).toBeNull();
    for (const extra of [
      [{ name: "test (node)", conclusion: "failure" }],
      [{ name: "test (node)", conclusion: "cancelled" }],
      [{ name: "test (node)", status: "in_progress", conclusion: undefined }],
      [{ name: "lint / types / test" }],
      [{ name: "late", run_id: 601 }],
      [{ name: "late", head_sha: "c".repeat(40) }],
    ])
      expect(await lookup([queueRun(600)], { 600: queueJobs(600, extra) })).toBeNull();
    const regated = queueJobs(600).map((job) =>
      job.name === "lint / types / test" ? { ...job, run_attempt: 2 } : job,
    );
    expect(await lookup([queueRun(600)], { 600: regated })).toBeNull();
    expect(await lookup([queueRun(600)], { 600: [] })).toBeNull();
  });

  it("applies only to a push to main of the same commit through this workflow", async () => {
    const jobs = { 600: queueJobs(600) };
    for (const current of [
      { event: "schedule" },
      { event: "pull_request" },
      { head_branch: "release" },
      { head_sha: "c".repeat(40) },
      { path: ".github/workflows/other.yml" },
      { workflow_id: 0 },
      { run_attempt: 2 },
    ])
      expect(await lookup([queueRun(600)], jobs, current)).toBeNull();
  });
});
