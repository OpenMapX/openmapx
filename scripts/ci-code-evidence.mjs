import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

export const sourcePrefix = "CI source v1 ";
const sha = /^[a-f0-9]{40}$/;
const positive = (value) => Number.isSafeInteger(value) && value > 0;
export function targetDigest({ baseRepositoryId, baseRef }) {
  if (!positive(baseRepositoryId) || typeof baseRef !== "string" || !baseRef.length)
    throw Error("Missing immutable PR target identity");
  return createHash("sha256")
    .update(JSON.stringify([baseRepositoryId, baseRef]))
    .digest("hex");
}
export function codeReceipt({ code, head, number, baseRepositoryId, baseRef, runId, attempt }) {
  if (typeof code !== "boolean" || !sha.test(head) || ![number, runId, attempt].every(positive))
    throw Error("Missing code validation source binding");
  return {
    v: 1,
    code,
    head,
    target: targetDigest({ baseRepositoryId, baseRef }),
    pr: number,
    run: runId,
    attempt,
  };
}

/** Read provider-owned job records, never candidate artifacts or copied green gates.
 * Missing legacy bindings deliberately require one fresh full validation. */
export async function findReusableCodeValidation({ current, source, runs, readJobs }) {
  if (
    !positive(current.id) ||
    !positive(current.workflow_id) ||
    current.head_sha !== source.head ||
    current.event !== "pull_request" ||
    current.path !== ".github/workflows/ci.yml"
  )
    return null;
  const target = targetDigest(source);
  const candidates = runs.filter((run) => run.id !== current.id && run.head_sha === source.head);
  const executionTime = (run) => Date.parse(run.run_started_at);
  if (
    candidates.some((run) => !positive(run.run_number) || !Number.isFinite(executionTime(run))) ||
    new Set(candidates.map((run) => run.id)).size !== candidates.length ||
    new Set(candidates.map((run) => run.run_number)).size !== candidates.length
  )
    return null;
  // Queued attempts have not necessarily updated their start time yet.
  if (candidates.some((run) => run.status === "queued")) return null;
  candidates.sort((a, b) => executionTime(b) - executionTime(a) || b.run_number - a.run_number);
  let best = null,
    bestTime = null;
  for (const run of candidates) {
    if (best && executionTime(run) < bestTime) return best;
    if (
      !positive(run.id) ||
      !positive(run.run_attempt) ||
      run.workflow_id !== current.workflow_id ||
      run.event !== "pull_request" ||
      run.path !== current.path
    )
      return null;
    const jobs = await readJobs(run.id);
    if (
      !Array.isArray(jobs) ||
      jobs.some((job) => job.run_id !== run.id || job.head_sha !== source.head)
    )
      return null;
    const selectors = jobs.filter((job) => job.name === "select required validation");
    if (
      selectors.length !== 1 ||
      selectors[0].status !== "completed" ||
      selectors[0].conclusion !== "success"
    )
      return null;
    const records = (selectors[0].steps ?? []).filter((step) =>
      step.name?.startsWith(sourcePrefix),
    );
    if (
      records.length !== 1 ||
      records[0].status !== "completed" ||
      records[0].conclusion !== "success"
    )
      return null;
    let receipt;
    try {
      receipt = JSON.parse(records[0].name.slice(sourcePrefix.length));
    } catch {
      return null;
    }
    if (
      receipt?.v !== 1 ||
      typeof receipt.code !== "boolean" ||
      receipt.head !== source.head ||
      receipt.target !== target ||
      receipt.pr !== source.number ||
      receipt.run !== run.id ||
      !positive(receipt.attempt) ||
      receipt.attempt > run.run_attempt
    )
      return null;
    const other = jobs.filter(
      (job) =>
        ![
          "select required validation",
          "lint / types / test",
          "build, scan, and publish Docker release",
        ].includes(job.name),
    );
    if (!receipt.code) {
      // A metadata gate is not a transitive source of code evidence.
      if (
        !other.length ||
        other.some((job) => job.status !== "completed" || job.conclusion !== "skipped")
      )
        return null;
      continue;
    }
    const gates = jobs.filter((job) => job.name === "lint / types / test");
    if (
      run.status !== "completed" ||
      run.conclusion !== "success" ||
      gates.length !== 1 ||
      gates[0].status !== "completed" ||
      gates[0].conclusion !== "success" ||
      gates[0].run_attempt !== run.run_attempt ||
      jobs.some(
        (job) => job.status !== "completed" || !["success", "skipped"].includes(job.conclusion),
      )
    )
      return null;
    bestTime = executionTime(run);
    best = {
      version: 1,
      runId: run.id,
      attempt: run.run_attempt,
      workflowId: run.workflow_id,
      head: source.head,
      target,
      pullRequest: source.number,
    };
  }
  return best;
}

export function sourceFromEvent(event) {
  const pr = event.pull_request;
  const source = {
    head: pr?.head?.sha,
    number: pr?.number ?? event.number,
    baseRef: pr?.base?.ref,
    baseRepositoryId: pr?.base?.repo?.id,
  };
  if (!sha.test(source.head) || !positive(source.number)) throw Error("Missing PR source identity");
  targetDigest(source);
  return source;
}
function api(path, paginate = false) {
  const result = JSON.parse(
    execFileSync("gh", ["api", ...(paginate ? ["--paginate", "--slurp"] : []), path], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      timeout: 60000,
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
  if (paginate && !Array.isArray(result)) throw Error("Incomplete GitHub pagination");
  return result;
}

function collection(path, key, maximum = 1000) {
  const pages = api(path, true);
  const expected = pages[0]?.total_count;
  if (
    !Number.isSafeInteger(expected) ||
    expected < 0 ||
    expected > maximum ||
    pages.some((page) => page.total_count !== expected || !Array.isArray(page[key]))
  )
    throw Error("Incomplete GitHub collection");
  const rows = pages.flatMap((page) => page[key]);
  if (rows.length !== expected) throw Error("Truncated GitHub collection");
  return rows;
}
/** No writes, privileged dispatches, branch-protection changes or merge attempts. */
export async function resolveCodeEvidence({ repository, runId, source }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !positive(runId))
    throw Error("Invalid GitHub validation identity");
  const prefix = `repos/${repository}`;
  const matches = (pr) =>
    pr.state === "open" &&
    pr.number === source.number &&
    pr.head?.sha === source.head &&
    pr.base?.repo?.id === source.baseRepositoryId &&
    pr.base?.ref === source.baseRef;
  if (!matches(api(`${prefix}/pulls/${source.number}`))) return null;
  const current = api(`${prefix}/actions/runs/${runId}`);
  if (!positive(current.workflow_id) || current.repository?.id !== source.baseRepositoryId)
    return null;
  const runs = collection(
    `${prefix}/actions/workflows/${current.workflow_id}/runs?head_sha=${source.head}&per_page=100`,
    "workflow_runs",
  );
  const evidence = await findReusableCodeValidation({
    current,
    source,
    runs,
    readJobs: (id) =>
      collection(`${prefix}/actions/runs/${id}/jobs?filter=latest&per_page=100`, "jobs"),
  });
  if (evidence) {
    const latest = api(`${prefix}/actions/runs/${evidence.runId}`);
    if (
      latest.status !== "completed" ||
      latest.conclusion !== "success" ||
      latest.run_attempt !== evidence.attempt ||
      latest.workflow_id !== evidence.workflowId ||
      latest.head_sha !== evidence.head
    )
      return null;
  }
  return matches(api(`${prefix}/pulls/${source.number}`)) ? evidence : null;
}
