// biome-ignore-all lint/suspicious/noUndeclaredEnvVars: Uncached GitHub Actions entry point.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";

import {
  codeReceipt,
  resolveCodeEvidence,
  resolveMergeQueueEvidence,
  sourceFromEvent,
  targetDigest,
} from "./ci-code-evidence.mjs";
import { databaseMatrix } from "./database-test-shards.mjs";

export const validationJobs = [
  "lint",
  "types",
  "test-node",
  "test-linux-user",
  "test-agent-image",
  "test-web",
  "mobile",
  "database",
  "build",
];
const shaPattern = /^[a-f0-9]{40}$/;

/**
 * The jobs each applicability scope leaves out. Every other job stays required.
 * @type {Record<string, string[]>}
 */
export const scopeSkippedJobs = {
  full: [],
  docs: validationJobs.filter((id) => !["lint", "test-node"].includes(id)),
  web: ["database", "mobile", "test-linux-user", "test-agent-image"],
  mobile: ["database", "test-web", "test-linux-user", "test-agent-image"],
  // Web and mobile client source, translations and docs prose. The mobile job
  // stays because it reads web sources and translations. The API's privacy
  // module imports the translations: its unit tests run in test-node, and its
  // database partitions run on main before publication.
  client: ["database", "test-linux-user", "test-agent-image"],
};
export const selectiveScopes = Object.keys(scopeSkippedJobs).filter((scope) => scope !== "full");
/** Database groups a pull request may leave to the merge queue. They take over
 * half of a full run's job time and still run on every merge-queue entry, on
 * main and on the daily schedule, so nothing reaches a release untested. */
export const mergeQueueDatabaseGroups = [
  "crash-points",
  "configuration-recovery",
  "coordinator-recovery",
];
const deferredGroups = (value) =>
  Array.isArray(value) &&
  new Set(value).size === value.length &&
  value.every((group) => mergeQueueDatabaseGroups.includes(group));
/** The database partitions this plan requires; verification uses the same list. */
export function plannedDatabaseMatrix(plan, matrix = databaseMatrix) {
  if (!deferredGroups(plan?.deferredDatabaseGroups))
    throw new Error("Missing or invalid deferred database groups");
  return matrix.filter((entry) => !plan.deferredDatabaseGroups.includes(entry.group));
}
const docsProse = (path) => /^docs\/(?:docs|blog)\/.*\.md$/.test(path);
const clientSource = (path) =>
  path.startsWith("apps/web/src/") ||
  path.startsWith("apps/mobile/src/") ||
  /^packages\/i18n\/locales\/[^/]+\.json$/.test(path);
function jobsForScope(scope) {
  if (!Object.hasOwn(scopeSkippedJobs, scope)) throw new Error("Unknown CI applicability scope");
  return Object.fromEntries(
    validationJobs.map((id) => [id, !scopeSkippedJobs[scope].includes(id)]),
  );
}
const safePath = (path) =>
  typeof path === "string" &&
  !path.startsWith("/") &&
  !path.includes("\\") &&
  !path.split("/").some((part) => part === ".." || !part);

/**
 * @param {object} options
 * @param {string} options.event
 * @param {string} [options.action]
 * @param {string} options.head
 * @param {string} [options.base]
 * @param {string[]} options.paths
 * @param {boolean} [options.baseChanged]
 * @param {boolean} [options.metadataGateReady]
 * @param {boolean} [options.metadataEditKnown]
 * @param {boolean} [options.mainCurrent]
 * @param {boolean} [options.pathsComplete]
 * @param {boolean} [options.regularFiles]
 * @param {string[]} [options.approvedScopes]
 * @param {string[]} [options.approvedMergeQueueGroups]
 * @param {boolean} [options.closedPr]
 * @param {string} [options.rolloutCommit]
 * @param {Record<string, unknown> | null} [options.validationSource]
 * @param {Record<string, unknown> | null} [options.mergeQueueSource]
 */
export function createImpactPlan({
  event,
  action,
  head,
  base,
  paths,
  baseChanged = false,
  metadataGateReady = false,
  metadataEditKnown = false,
  mainCurrent = true,
  pathsComplete = true,
  regularFiles = true,
  approvedScopes = [],
  approvedMergeQueueGroups = [],
  closedPr = false,
  rolloutCommit = "",
  validationSource = null,
  mergeQueueSource = null,
}) {
  if (!shaPattern.test(head) || (event === "pull_request" && !shaPattern.test(base)))
    throw new Error("CI selection requires immutable head/base commit identities");
  // Unknown lifecycle fields run full validation, never infer a metadata edit.
  const metadataCandidate =
    event === "pull_request" &&
    action === "edited" &&
    !baseChanged &&
    metadataGateReady &&
    metadataEditKnown;
  const metadataOnly = metadataCandidate && validCodeEvidence(validationSource, head);
  // A push of a commit the merge queue validated in full; force-merged commits
  // have no such run and keep the complete validation.
  const mergeQueueValidated =
    event === "push" && !closedPr && mainCurrent && validMergeQueueEvidence(mergeQueueSource, head);
  let scope = "full";
  if (
    event === "pull_request" &&
    !metadataOnly &&
    action !== "edited" &&
    !baseChanged &&
    ["opened", "synchronize", "reopened", "edited"].includes(action) &&
    pathsComplete &&
    regularFiles &&
    Array.isArray(paths) &&
    paths.length > 0 &&
    paths.every(safePath)
  ) {
    if (paths.every(docsProse)) {
      scope = "docs";
    } else if (
      paths.every((path) => /^apps\/web\/src\/components\/.*\.[jt]sx?$/.test(path)) &&
      !paths.includes("apps/web/src/components/search/VoiceSearchButton.tsx")
    ) {
      // Keep node-side source/build contracts, all types and the actual web build.
      scope = "web";
    } else if (paths.every((path) => /^apps\/mobile\/src\/.*\.[jt]sx?$/.test(path))) {
      scope = "mobile";
    } else if (paths.every((path) => clientSource(path) || docsProse(path))) {
      scope = "client";
    }
  }
  const proposedScope = scope;
  if (!Array.isArray(approvedScopes) || !approvedScopes.includes(scope)) scope = "full";
  const jobs = jobsForScope(scope);
  // Approved on the default branch once the merge queue is required there.
  const deferredDatabaseGroups =
    event === "pull_request" && jobs.database && deferredGroups(approvedMergeQueueGroups)
      ? [...approvedMergeQueueGroups].sort()
      : [];
  return {
    version: 1,
    event,
    head,
    base: base ?? "",
    code: !closedPr && !metadataOnly && mainCurrent && !mergeQueueValidated,
    reason: closedPr
      ? "closed-pr"
      : !mainCurrent
        ? "superseded-main"
        : metadataOnly
          ? "metadata-only"
          : mergeQueueValidated
            ? "merge-queue-validated"
            : metadataCandidate
              ? "metadata-requires-validation"
              : "code",
    scope,
    proposedScope,
    validationSource: metadataOnly
      ? validationSource
      : mergeQueueValidated
        ? mergeQueueSource
        : null,
    rolloutCommit,
    changedPathCount: paths?.length ?? 0,
    changedPathDigest: createHash("sha256")
      .update(JSON.stringify([...(paths ?? [])].sort()))
      .digest("hex"),
    jobs,
    deferredDatabaseGroups,
  };
}

function validCodeEvidence(value, head) {
  return (
    value?.version === 1 &&
    value.head === head &&
    /^[a-f0-9]{64}$/.test(value.target) &&
    [value.runId, value.attempt, value.workflowId, value.pullRequest].every(
      (id) => Number.isSafeInteger(id) && id > 0,
    )
  );
}

function validMergeQueueEvidence(value, head) {
  return (
    value?.version === 1 &&
    value.head === head &&
    Object.keys(value).length === 5 &&
    [value.runId, value.attempt, value.workflowId].every((id) => Number.isSafeInteger(id) && id > 0)
  );
}

/** The push run validates nothing itself: every validation job must be skipped. */
export function verifyMergeQueueResults(plan, needs) {
  if (
    plan?.version !== 1 ||
    plan.event !== "push" ||
    plan.code !== false ||
    plan.reason !== "merge-queue-validated" ||
    plan.scope !== "full" ||
    !validMergeQueueEvidence(plan.validationSource, plan.head) ||
    needs.select?.result !== "success"
  )
    throw Error("Missing merge-queue validation receipt");
  const expected = ["select", ...validationJobs, "docker-changes", "docker-build"];
  if (JSON.stringify(Object.keys(needs).sort()) !== JSON.stringify(expected.sort()))
    throw Error("Unknown or missing merge-queue gate dependency");
  for (const id of expected.filter((id) => id !== "select"))
    if (needs[id].result !== "skipped") throw Error(`${id}: reused validation must be skipped`);
}

export function verifyMetadataResults(plan, needs) {
  if (
    plan?.version !== 1 ||
    plan.event !== "pull_request" ||
    plan.code !== false ||
    plan.reason !== "metadata-only" ||
    !validCodeEvidence(plan.validationSource, plan.head) ||
    needs.select?.result !== "success"
  )
    throw Error("Missing metadata validation receipt");
  const expected = ["select", ...validationJobs, "docker-changes", "docker-build"];
  if (JSON.stringify(Object.keys(needs).sort()) !== JSON.stringify(expected.sort()))
    throw Error("Unknown or missing metadata gate dependency");
  for (const id of expected.filter((id) => id !== "select"))
    if (needs[id].result !== "skipped") throw Error(`${id}: metadata validation must be skipped`);
}

export function verifyResults(plan, needs, event) {
  if (
    plan?.version !== 1 ||
    plan.event !== event ||
    plan.code !== true ||
    !shaPattern.test(plan.head) ||
    (event === "pull_request" && !shaPattern.test(plan.base)) ||
    JSON.stringify(Object.keys(plan.jobs ?? {}).sort()) !==
      JSON.stringify([...validationJobs].sort()) ||
    Object.values(plan.jobs).some((value) => typeof value !== "boolean")
  )
    throw new Error("Missing or invalid CI selection receipt");
  const unknown = Object.keys(needs).filter(
    (id) => !["select", ...validationJobs, "docker-changes", "docker-build"].includes(id),
  );
  if (unknown.length) throw new Error(`Unknown aggregate dependencies: ${unknown.join(", ")}`);
  if (event !== "pull_request" && plan.scope !== "full")
    throw new Error("Trusted main requires complete validation");
  if (!deferredGroups(plan.deferredDatabaseGroups))
    throw new Error("Missing or invalid deferred database groups");
  if (plan.deferredDatabaseGroups.length && (event !== "pull_request" || !plan.jobs.database))
    throw new Error("Only a pull request may leave database groups to the merge queue");
  const expected = jobsForScope(plan.scope);
  if (validationJobs.some((id) => plan.jobs[id] !== expected[id]))
    throw new Error("CI job selection does not match its declared scope");
  for (const id of validationJobs) {
    const expected = plan.jobs[id] ? "success" : "skipped";
    if (needs[id]?.result !== expected)
      throw new Error(`${id}: expected ${expected}, got ${needs[id]?.result}`);
  }
  if (event === "pull_request") {
    if (needs["docker-changes"]?.result !== "success") throw new Error("Missing Docker selection");
    const apps = JSON.parse(needs["docker-changes"].outputs?.apps ?? "null");
    if (!Array.isArray(apps) || apps.some((app) => typeof app !== "string"))
      throw new Error("Invalid Docker selection");
    const expected = apps.length ? "success" : "skipped";
    if (needs["docker-build"]?.result !== expected)
      throw new Error(`Docker validation must be ${expected}`);
  } else if (["docker-changes", "docker-build"].some((id) => needs[id]?.result !== "skipped")) {
    throw new Error("Trusted main must skip PR-only Docker validation");
  }
}

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
}
if (import.meta.main) {
  try {
    if (process.argv[2] === "verify") {
      const needs = JSON.parse(process.env.CI_NEEDS);
      if (needs.select?.result !== "success") throw new Error("CI selector did not succeed");
      const plan = JSON.parse(process.env.CI_PLAN);
      if (plan.head !== process.env.CI_HEAD || plan.base !== (process.env.CI_BASE ?? ""))
        throw new Error("CI selection receipt belongs to different source");
      verifyResults(plan, needs, process.env.GITHUB_EVENT_NAME);
      console.log("All selected validation jobs succeeded; all inapplicable jobs skipped.");
    } else if (process.argv[2] === "verify-merge-queue") {
      const plan = JSON.parse(process.env.CI_PLAN);
      verifyMergeQueueResults(plan, JSON.parse(process.env.CI_NEEDS));
      if (
        process.env.GITHUB_EVENT_NAME !== "push" ||
        process.env.GITHUB_REF !== "refs/heads/main" ||
        plan.head !== process.env.CI_HEAD ||
        plan.head !== process.env.GITHUB_SHA
      )
        throw Error("Merge-queue validation belongs to different source");
      const evidence = await resolveMergeQueueEvidence({
        repository: process.env.GITHUB_REPOSITORY,
        runId: Number(process.env.GITHUB_RUN_ID),
        head: plan.head,
      });
      if (
        !evidence ||
        evidence.runId !== plan.validationSource.runId ||
        evidence.attempt !== plan.validationSource.attempt ||
        evidence.workflowId !== plan.validationSource.workflowId
      )
        throw Error(
          "The merge-queue validation is no longer reusable; full validation is required",
        );
      console.log(
        `Reused merge-queue run ${evidence.runId}, attempt ${evidence.attempt}, head ${evidence.head}`,
      );
      if (process.env.GITHUB_STEP_SUMMARY)
        appendFileSync(
          process.env.GITHUB_STEP_SUMMARY,
          `### Required code gate\n\nReused merge-queue run ${evidence.runId}, attempt ${evidence.attempt}, head ${evidence.head}.\n`,
        );
    } else if (process.argv[2] === "verify-reuse") {
      const plan = JSON.parse(process.env.CI_PLAN);
      verifyMetadataResults(plan, JSON.parse(process.env.CI_NEEDS));
      const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
      const source = sourceFromEvent(event);
      if (
        plan.head !== process.env.CI_HEAD ||
        plan.head !== source.head ||
        plan.base !== process.env.CI_BASE ||
        plan.validationSource.target !== targetDigest(source) ||
        plan.validationSource.pullRequest !== source.number
      )
        throw Error("Metadata validation belongs to different source");
      const evidence = await resolveCodeEvidence({
        repository: process.env.GITHUB_REPOSITORY,
        runId: Number(process.env.GITHUB_RUN_ID),
        source,
      });
      if (!evidence)
        throw Error(
          "Successful current code validation is no longer reusable; full validation is required",
        );
      console.log(
        `Revalidated code run ${evidence.runId}, attempt ${evidence.attempt}, head ${evidence.head}`,
      );
      if (process.env.GITHUB_STEP_SUMMARY)
        appendFileSync(
          process.env.GITHUB_STEP_SUMMARY,
          `### Required code gate\n\nRevalidated code run ${evidence.runId}, attempt ${evidence.attempt}, head ${evidence.head}.\n`,
        );
    } else if (process.argv[2] === "select") {
      const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
      const pr = event.pull_request;
      const head = pr?.head?.sha ?? process.env.GITHUB_SHA;
      const base = pr?.base?.sha ?? "";
      let paths = [],
        regularFiles = true;
      if (pr && pr.state !== "closed") {
        if (!shaPattern.test(base) || !shaPattern.test(head))
          throw new Error("Invalid PR source identity");
        const ancestor = git("merge-base", base, head).trim();
        paths = git("diff", "--no-renames", "--name-only", "-z", ancestor, head)
          .split("\0")
          .filter(Boolean);
        for (const ref of [ancestor, head]) {
          const modes = new Map(
            git("ls-tree", "-r", "-z", ref)
              .split("\0")
              .filter(Boolean)
              .map((line) => [line.slice(line.indexOf("\t") + 1), line.slice(0, 6)]),
          );
          if (
            paths.some((path) => modes.has(path) && !["100644", "100755"].includes(modes.get(path)))
          )
            regularFiles = false;
        }
      }
      let metadataGateReady = false;
      let approvedScopes = [];
      let approvedMergeQueueGroups = [];
      let rolloutCommit = "";
      try {
        // Approval is a reviewed default-branch input, never a PR opt-in.
        rolloutCommit = git("rev-parse", "origin/main").trim();
        const rollout = JSON.parse(git("show", "origin/main:scripts/ci-impact-rollout.json"));
        if (
          rollout.version === 1 &&
          Array.isArray(rollout.approvedScopes) &&
          rollout.approvedScopes.every((scope) => selectiveScopes.includes(scope))
        )
          approvedScopes = rollout.approvedScopes;
        if (rollout.version === 1 && deferredGroups(rollout.mergeQueueDatabaseGroups))
          approvedMergeQueueGroups = rollout.mergeQueueDatabaseGroups;
      } catch {
        /* Missing/unknown rollout policy keeps the complete gate. */
      }
      try {
        // Default-branch workflow only: a PR cannot opt itself into the rollout.
        const policy = git("show", "origin/main:.github/workflows/pr-title.yml");
        metadataGateReady =
          policy.includes("# CI metadata gate v1") &&
          policy.includes("node scripts/validate-pr-metadata.mjs") &&
          !!pr &&
          policy === git("show", `origin/${pr.base.ref ?? "main"}:.github/workflows/pr-title.yml`);
      } catch {
        /* Old bases keep the full code gate on edits. */
      }
      const metadataEditKnown =
        !!event.changes &&
        Object.keys(event.changes).length > 0 &&
        Object.keys(event.changes).every((key) => ["body", "title"].includes(key));
      let validationSource = null;
      if (
        pr?.state !== "closed" &&
        process.env.GITHUB_EVENT_NAME === "pull_request" &&
        event.action === "edited" &&
        !event.changes?.base &&
        metadataEditKnown &&
        metadataGateReady
      ) {
        try {
          validationSource = await resolveCodeEvidence({
            repository: process.env.GITHUB_REPOSITORY,
            runId: Number(process.env.GITHUB_RUN_ID),
            source: sourceFromEvent(event),
          });
        } catch {
          console.log("No complete provider-bound code proof; running full validation.");
        }
      }
      const mainCurrent =
        process.env.GITHUB_REF !== "refs/heads/main" ||
        process.env.GITHUB_EVENT_NAME === "pull_request" ||
        git("rev-parse", "origin/main").trim() === head;
      let mergeQueueSource = null;
      if (
        process.env.GITHUB_EVENT_NAME === "push" &&
        process.env.GITHUB_REF === "refs/heads/main" &&
        mainCurrent
      ) {
        try {
          mergeQueueSource = await resolveMergeQueueEvidence({
            repository: process.env.GITHUB_REPOSITORY,
            runId: Number(process.env.GITHUB_RUN_ID),
            head,
          });
        } catch (error) {
          console.log(
            `No reusable merge-queue validation (${error.message}); running full validation.`,
          );
        }
      }
      const plan = createImpactPlan({
        event: process.env.GITHUB_EVENT_NAME,
        action: event.action,
        head,
        base,
        paths,
        regularFiles,
        validationSource,
        approvedScopes,
        approvedMergeQueueGroups,
        rolloutCommit,
        closedPr: pr?.state === "closed",
        baseChanged: !!event.changes?.base,
        mainCurrent,
        mergeQueueSource,
        metadataGateReady,
        metadataEditKnown,
      });
      let receipt = null;
      if (pr) {
        try {
          receipt = codeReceipt({
            ...sourceFromEvent(event),
            code: plan.code,
            runId: Number(process.env.GITHUB_RUN_ID),
            attempt: Number(process.env.GITHUB_RUN_ATTEMPT),
          });
        } catch {
          if (process.env.GITHUB_ACTIONS === "true")
            throw Error("Missing provider source receipt binding");
        }
      }
      const lines = Object.entries({
        plan: JSON.stringify(plan),
        source: JSON.stringify(receipt),
        "database-matrix": JSON.stringify({ include: plannedDatabaseMatrix(plan) }),
        code: plan.code,
        reason: plan.reason,
        ...plan.jobs,
        head: plan.head,
        base: plan.base,
      })
        .map(([key, value]) => `${key}=${value}\n`)
        .join("");
      appendFileSync(process.env.GITHUB_OUTPUT, lines);
      console.log(JSON.stringify(plan, null, 2));
      if (process.env.GITHUB_STEP_SUMMARY)
        appendFileSync(
          process.env.GITHUB_STEP_SUMMARY,
          `### CI applicability receipt\n\n\`\`\`json\n${JSON.stringify(plan, null, 2)}\n\`\`\`\n`,
        );
    } else throw new Error("Usage: ci-impact-plan.mjs select|verify");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
