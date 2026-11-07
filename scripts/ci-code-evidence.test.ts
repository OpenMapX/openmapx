import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { codeReceipt, findReusableCodeValidation, targetDigest } from "./ci-code-evidence.mjs";

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
    expect(targetDigest(source)).toBe(targetDigest({ ...source, baseSha: "new-main" }));
    expect(targetDigest(source)).not.toBe(targetDigest({ ...source, baseRef: "release" }));
  });
});
