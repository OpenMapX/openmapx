// biome-ignore-all lint/suspicious/noUndeclaredEnvVars: Uncached GitHub Actions entry point.
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";

import { databaseMatrix } from "./database-test-shards.mjs";

export const validationJobs = [
  "lint",
  "types",
  "test-node",
  "test-linux-user",
  "test-agent-mounts",
  "test-web",
  "mobile",
  "database",
  "build",
];
const shaPattern = /^[a-f0-9]{40}$/;
const full = () => Object.fromEntries(validationJobs.map((id) => [id, true]));
const safePath = (path) =>
  typeof path === "string" &&
  !path.startsWith("/") &&
  !path.includes("\\") &&
  !path.split("/").some((part) => part === ".." || !part);

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
}) {
  if (!shaPattern.test(head) || (event === "pull_request" && !shaPattern.test(base)))
    throw new Error("CI selection requires immutable head/base commit identities");
  const jobs = full();
  // Unknown lifecycle fields run full validation, never infer a metadata edit.
  const metadataOnly =
    event === "pull_request" &&
    action === "edited" &&
    !baseChanged &&
    metadataGateReady &&
    metadataEditKnown;
  let scope = "full";
  if (
    event === "pull_request" &&
    !metadataOnly &&
    !baseChanged &&
    ["opened", "synchronize", "reopened", "edited"].includes(action) &&
    pathsComplete &&
    regularFiles &&
    Array.isArray(paths) &&
    paths.length > 0 &&
    paths.every(safePath)
  ) {
    if (paths.every((path) => /^docs\/(?:docs|blog)\/.*\.md$/.test(path))) {
      scope = "docs";
      for (const id of validationJobs) jobs[id] = id === "lint";
    } else if (paths.every((path) => /^apps\/web\/src\/components\/.*\.[jt]sx?$/.test(path))) {
      // Keep node-side source/build contracts, all types and the actual web build.
      scope = "web";
      for (const id of ["database", "mobile", "test-linux-user", "test-agent-mounts"])
        jobs[id] = false;
    } else if (paths.every((path) => /^apps\/mobile\/src\/.*\.[jt]sx?$/.test(path))) {
      scope = "mobile";
      for (const id of ["database", "test-web", "test-linux-user", "test-agent-mounts"])
        jobs[id] = false;
    }
  }
  const proposedScope = scope;
  if (!Array.isArray(approvedScopes) || !approvedScopes.includes(scope)) {
    scope = "full";
    Object.assign(jobs, full());
  }
  return {
    version: 1,
    event,
    head,
    base: base ?? "",
    code: !metadataOnly && mainCurrent,
    reason: !mainCurrent ? "superseded-main" : metadataOnly ? "metadata-only" : "code",
    scope,
    proposedScope,
    jobs,
  };
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
  const expected = full();
  if (event !== "pull_request" && plan.scope !== "full")
    throw new Error("Trusted main requires complete validation");
  if (plan.scope === "docs") for (const id of validationJobs) expected[id] = id === "lint";
  else if (plan.scope === "web")
    for (const id of ["database", "mobile", "test-linux-user", "test-agent-mounts"])
      expected[id] = false;
  else if (plan.scope === "mobile")
    for (const id of ["database", "test-web", "test-linux-user", "test-agent-mounts"])
      expected[id] = false;
  else if (plan.scope !== "full") throw new Error("Unknown CI applicability scope");
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
    } else if (process.argv[2] === "select") {
      const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
      const pr = event.pull_request;
      const head = pr?.head?.sha ?? process.env.GITHUB_SHA;
      const base = pr?.base?.sha ?? "";
      let paths = [],
        regularFiles = true;
      if (pr) {
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
      try {
        // Approval is a reviewed default-branch input, never a PR opt-in.
        const rollout = JSON.parse(git("show", "origin/main:scripts/ci-impact-rollout.json"));
        if (
          rollout.version === 1 &&
          Array.isArray(rollout.approvedScopes) &&
          rollout.approvedScopes.every((scope) => ["docs", "web", "mobile"].includes(scope))
        )
          approvedScopes = rollout.approvedScopes;
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
          policy === git("show", `${base}:.github/workflows/pr-title.yml`);
      } catch {
        /* Old bases keep the full code gate on edits. */
      }
      const plan = createImpactPlan({
        event: process.env.GITHUB_EVENT_NAME,
        action: event.action,
        head,
        base,
        paths,
        regularFiles,
        approvedScopes,
        baseChanged: !!event.changes?.base,
        mainCurrent:
          process.env.GITHUB_REF !== "refs/heads/main" ||
          process.env.GITHUB_EVENT_NAME === "pull_request" ||
          git("rev-parse", "origin/main").trim() === head,
        metadataGateReady,
        metadataEditKnown:
          !!event.changes &&
          Object.keys(event.changes).length > 0 &&
          Object.keys(event.changes).every((key) => ["body", "title"].includes(key)),
      });
      const lines = Object.entries({
        plan: JSON.stringify(plan),
        "database-matrix": JSON.stringify({ include: databaseMatrix }),
        code: plan.code,
        ...plan.jobs,
        head: plan.head,
        base: plan.base,
      })
        .map(([key, value]) => `${key}=${value}\n`)
        .join("");
      appendFileSync(process.env.GITHUB_OUTPUT, lines);
      console.log(JSON.stringify(plan, null, 2));
    } else throw new Error("Usage: ci-impact-plan.mjs select|verify");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
