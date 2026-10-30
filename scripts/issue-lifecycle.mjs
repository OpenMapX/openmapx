import { readFileSync } from "node:fs";

const labels = JSON.parse(readFileSync(new URL("../.github/labels.json", import.meta.url), "utf8"));
const workflowLabels = ["needs-triage", "needs-info"];
const fieldPolicy = [
  { name: "Priority", visibility: "public", options: ["High", "Low", "Medium", "Urgent"] },
  { name: "Effort", visibility: "public", options: ["High", "Low", "Medium"] },
  { name: "Start date", visibility: "organization_members_only" },
  { name: "Target date", visibility: "organization_members_only" },
];
const labelNames = (issue) => issue.labels.map((label) => label.name);

async function wasTriaged(github, request) {
  const events = await github.paginate(github.rest.issues.listEvents, {
    ...request,
    per_page: 100,
  });
  const reopened = Math.max(
    0,
    ...events.filter((event) => event.event === "reopened").map((event) => event.id),
  );
  return events.some(
    (event) =>
      event.id > reopened &&
      event.event === "unlabeled" &&
      event.label?.name === "needs-triage" &&
      event.actor?.type !== "Bot",
  );
}

/** Metadata only. GitHub has no atomic state-and-label update; re-read before
 * writes, reconcile observed transitions, and fail visibly if state keeps moving. */
export async function handleIssueLifecycle({ github, context }) {
  if (
    context.eventName !== "issues" ||
    !["opened", "reopened", "closed"].includes(context.payload.action) ||
    context.payload.issue?.pull_request
  )
    return;
  const number = context.payload.issue?.number;
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error("Missing issue number");
  const request = { ...context.repo, issue_number: number };
  let sawClosed = false;
  let addedTriage = false;
  const removedHumanLabels = new Set();
  for (let attempt = 0; attempt < 8; attempt++) {
    const { data: issue } = await github.rest.issues.get(request);
    if (issue.pull_request) return;
    const current = labelNames(issue);
    if (issue.state === "closed") {
      sawClosed = true;
      const name = workflowLabels.find((label) => current.includes(label));
      if (!name) return;
      try {
        await github.rest.issues.removeLabel({ ...request, name });
      } catch (error) {
        if (error.status !== 404) throw error;
        // A 404 can mean a raced removal or lost access. Confirm the issue is
        // still readable and the label really disappeared before accepting it.
        const { data: refreshed } = await github.rest.issues.get(request);
        if (labelNames(refreshed).includes(name)) throw error;
      }
      if (name !== "needs-triage") removedHumanLabels.add(name);
      continue;
    }
    if (issue.state !== "open") throw new Error("Unknown issue state");
    const ambiguous = [...removedHumanLabels].filter((name) => !current.includes(name));
    if (ambiguous.length) {
      // State and label writes are not atomic. Re-adding a semantic label here
      // could undo a later human decision; surface the exact history to review.
      throw new Error(
        `Issue #${number} reopened during cleanup of ${ambiguous.join(", ")}; check issue history before restoring labels`,
      );
    }
    if (context.payload.action === "closed" && !sawClosed) return;
    if (current.includes("needs-triage") && !addedTriage) return;
    const reviewed = await wasTriaged(github, request);
    const { data: refreshed } = await github.rest.issues.get(request);
    if (
      refreshed.state !== issue.state ||
      refreshed.updated_at !== issue.updated_at ||
      JSON.stringify(labelNames(refreshed)) !== JSON.stringify(current)
    )
      continue;
    if (current.includes("needs-triage")) {
      if (reviewed) {
        // Undo only our own addition if a human completed triage while our
        // request was in flight. Other open workflow labels stay human-owned.
        await github.rest.issues.removeLabel({ ...request, name: "needs-triage" });
        continue;
      }
      return;
    }
    if (reviewed) return;
    await github.rest.issues.addLabels({ ...request, labels: ["needs-triage"] });
    addedTriage = true;
  }
  throw new Error("Issue changed repeatedly; retry lifecycle housekeeping");
}

/** No writes, comments or semantic classification. A successful report run is
 * not a clean audit: its findings and unverified checks must be read explicitly. */
export async function reportIssueDrift({ github, context }) {
  const request = { ...context.repo, per_page: 100 };
  const actualLabels = await github.paginate(github.rest.issues.listLabelsForRepo, request);
  const items = await github.paginate(github.rest.issues.listForRepo, { ...request, state: "all" });
  const issues = items.filter((issue) => !issue.pull_request);
  const expectedNames = new Set(labels.map((label) => label.name));
  const actualNames = new Set(actualLabels.map((label) => label.name));
  const report = {
    issueCount: issues.length,
    closedWorkflowLabels: issues
      .filter((issue) => issue.state === "closed")
      .map((issue) => ({
        number: issue.number,
        labels: labelNames(issue).filter((name) => workflowLabels.includes(name)),
      }))
      .filter((issue) => issue.labels.length > 0),
    unknownLabels: actualLabels
      .filter((label) => !expectedNames.has(label.name))
      .map((label) => label.name)
      .sort(),
    missingLabels: labels
      .filter((label) => !actualNames.has(label.name))
      .map((label) => label.name),
    labelDefinitionDrift: labels
      .filter((label) => {
        const actual = actualLabels.find((candidate) => candidate.name === label.name);
        return (
          actual &&
          (actual.color.toLowerCase() !== label.color ||
            (actual.description ?? "") !== label.description)
        );
      })
      .map((label) => label.name),
    openWithoutType: issues
      .filter((issue) => issue.state === "open" && !issue.type)
      .map((issue) => issue.number),
    fieldAccess: "checked",
    fieldDrift: [],
  };
  let fields;
  try {
    fields = await github.paginate("GET /orgs/{org}/issue-fields", {
      org: context.repo.owner,
      per_page: 100,
      headers: { "X-GitHub-Api-Version": "2026-03-10" },
    });
  } catch (error) {
    if (![403, 404].includes(error.status)) throw error;
    // Repository GITHUB_TOKEN cannot grant organization Issue Fields access.
    // Do not add a broad PAT just to make this report look green.
    report.fieldAccess = "unverified";
    report.fieldDrift = null;
    return report;
  }
  for (const expected of fieldPolicy) {
    const actual = fields.find((field) => field.name === expected.name);
    if (!actual || actual.visibility !== expected.visibility)
      report.fieldDrift.push({
        name: expected.name,
        expected: expected.visibility,
        actual: actual?.visibility ?? "missing",
      });
    if (
      actual &&
      expected.options &&
      JSON.stringify(actual.options?.map((option) => option.name).sort()) !==
        JSON.stringify(expected.options)
    )
      report.fieldDrift.push({
        name: expected.name,
        expectedOptions: expected.options,
        actualOptions: actual.options?.map((option) => option.name) ?? [],
      });
  }
  return report;
}
