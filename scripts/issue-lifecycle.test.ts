import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const { load } = createRequire(new URL("../packages/core/package.json", import.meta.url))(
  "js-yaml",
);
const workflow = load(
  readFileSync(new URL("../.github/workflows/issue-lifecycle.yml", import.meta.url), "utf8"),
);

import { handleIssueLifecycle, reportIssueDrift } from "./issue-lifecycle.mjs";

type Issue = {
  number: number;
  state: string;
  labels: { name: string }[];
  updated_at: string;
  pull_request?: object;
  type?: { name: string } | null;
};
type Event = { id: number; event: string; label?: { name: string }; actor?: { type: string } };
function fixture(
  state = "closed",
  names = ["needs-triage", "needs-info", "blocked", "integration"],
) {
  const issue: Issue = {
    number: 42,
    state,
    labels: names.map((name) => ({ name })),
    updated_at: "initial",
  };
  const events: Event[] = [];
  let revision = 0;
  let beforeRemove = (_name: string) => {};
  let beforeAdd = () => {};
  const snapshot = () => structuredClone(issue);
  const github = {
    rest: {
      issues: {
        get: async () => ({ data: snapshot() }),
        removeLabel: async ({ name }: { name: string }) => {
          beforeRemove(name);
          issue.labels = issue.labels.filter((label) => label.name !== name);
          issue.updated_at = String(++revision);
        },
        addLabels: async ({ labels }: { labels: string[] }) => {
          beforeAdd();
          issue.labels.push(
            ...labels
              .filter((name) => !issue.labels.some((label) => label.name === name))
              .map((name) => ({ name })),
          );
          issue.updated_at = String(++revision);
        },
        listEvents: "events",
      },
    },
    paginate: async () => structuredClone(events),
  };
  const run = (action = "closed", eventName = "issues", payload: object = {}) =>
    handleIssueLifecycle({
      github,
      context: {
        eventName,
        repo: { owner: "OpenMapX", repo: "openmapx" },
        payload: { action, issue: { number: 42, ...payload } },
      },
    });
  return {
    issue,
    events,
    github,
    run,
    onRemove(fn: (name: string) => void) {
      beforeRemove = fn;
    },
    onAdd(fn: () => void) {
      beforeAdd = fn;
    },
  };
}
const names = (issue: Issue) => issue.labels.map((label) => label.name).sort();

describe("issue lifecycle housekeeping", () => {
  it("removes only active workflow labels on close and leaves issue state/type untouched", async () => {
    const f = fixture();
    f.issue.type = { name: "Task" };
    await f.run();
    await f.run();
    expect(names(f.issue)).toEqual(["integration"]);
    expect(f.issue.state).toBe("closed");
    expect(f.issue.type).toEqual({ name: "Task" });
  });
  it.each(["opened", "reopened"])("adds initial triage once for %s", async (action) => {
    const f = fixture("open", ["integration"]);
    await f.run(action);
    await f.run(action);
    expect(names(f.issue)).toEqual(["integration", "needs-triage"]);
  });
  it("does not strip labels when an old close event arrives after reopening", async () => {
    const f = fixture("open");
    await f.run("closed");
    expect(names(f.issue)).toEqual(["blocked", "integration", "needs-info", "needs-triage"]);
  });
  it("cleans current closed state when an old reopen event arrives", async () => {
    const f = fixture();
    await f.run("reopened");
    expect(names(f.issue)).toEqual(["integration"]);
  });
  it("preserves human triage on retry even with events returned out of order", async () => {
    const f = fixture("open", ["integration"]);
    f.events.push(
      { id: 3, event: "unlabeled", label: { name: "needs-triage" }, actor: { type: "User" } },
      { id: 2, event: "reopened" },
    );
    await f.run("reopened");
    expect(names(f.issue)).toEqual(["integration"]);
  });
  it("does not confuse a previous close cleanup with triage after a new reopen", async () => {
    const f = fixture("open", ["integration"]);
    f.events.push(
      { id: 1, event: "unlabeled", label: { name: "needs-triage" }, actor: { type: "Bot" } },
      { id: 2, event: "reopened" },
    );
    await f.run("reopened");
    expect(names(f.issue)).toEqual(["integration", "needs-triage"]);
  });
  it("reconciles reopening during close cleanup without removing the remaining open labels", async () => {
    const f = fixture();
    f.onRemove(() => {
      f.issue.state = "open";
    });
    await f.run();
    expect(names(f.issue)).toEqual(["blocked", "integration", "needs-info", "needs-triage"]);
  });
  it.each([
    ["needs-info", ["needs-info", "blocked"]],
    ["blocked", ["blocked", "integration"]],
    ["needs-info", ["needs-triage", "needs-info", "blocked"]],
    ["blocked", ["needs-triage", "needs-info", "blocked"]],
  ])(
    "reports an ambiguous reopen during removal of %s instead of claiming success",
    async (target, labels) => {
      const f = fixture("closed", labels);
      f.onRemove((name) => {
        if (name === target) f.issue.state = "open";
      });
      await expect(f.run()).rejects.toThrow(
        new RegExp(`Issue #42 reopened during cleanup.*${target}.*history`),
      );
      expect(names(f.issue)).not.toContain(target);
      expect(f.issue.state).toBe("open");
    },
  );
  it("does not overwrite later human label decisions when reporting a reopen race", async () => {
    const f = fixture("closed", ["needs-info", "blocked"]);
    f.onRemove(() => {
      f.issue.state = "open";
      f.issue.labels = [{ name: "needs-info" }, { name: "help wanted" }];
      f.events.push({
        id: 3,
        event: "unlabeled",
        label: { name: "blocked" },
        actor: { type: "User" },
      });
    });
    await expect(f.run()).rejects.toThrow(/Issue #42 reopened during cleanup.*needs-info.*history/);
    expect(names(f.issue)).toEqual(["help wanted"]);
  });
  it("cleans up if an issue closes while a reopen label is being added", async () => {
    const f = fixture("open", ["integration"]);
    f.onAdd(() => {
      f.issue.state = "closed";
    });
    await f.run("reopened");
    expect(names(f.issue)).toEqual(["integration"]);
  });
  it("does not overwrite human triage racing with the add request", async () => {
    const f = fixture("open", ["integration"]);
    f.events.push({ id: 1, event: "reopened" });
    f.onAdd(() => {
      f.events.push({
        id: 2,
        event: "unlabeled",
        label: { name: "needs-triage" },
        actor: { type: "User" },
      });
    });
    await f.run("reopened");
    expect(names(f.issue)).toEqual(["integration"]);
  });
  it.each(["commented", "labeled"])("ignores unrelated %s actions", async (action) => {
    const f = fixture();
    await f.run(action);
    expect(names(f.issue)).toHaveLength(4);
  });
  it("ignores PR payloads and non-issue events before any API access", async () => {
    const f = fixture();
    f.github.rest.issues.get = async () => {
      throw new Error("Unexpected read");
    };
    await f.run("closed", "pull_request");
    await f.run("closed", "issues", { pull_request: {} });
  });
  it("also excludes PRs returned by the issues API", async () => {
    const f = fixture();
    f.issue.pull_request = {};
    await f.run();
    expect(names(f.issue)).toHaveLength(4);
  });
  it("tolerates a raced missing label only after confirming its absence", async () => {
    const f = fixture();
    f.github.rest.issues.removeLabel = async ({ name }) => {
      f.issue.labels = f.issue.labels.filter((label) => label.name !== name);
      throw Object.assign(new Error("Not Found"), { status: 404 });
    };
    await f.run();
    expect(names(f.issue)).toEqual(["integration"]);
  });
  it.each([403, 404, 500])(
    "propagates removal errors (%s) when the label is still present",
    async (status) => {
      const f = fixture();
      f.github.rest.issues.removeLabel = async () => {
        throw Object.assign(new Error("API failure"), { status });
      };
      await expect(f.run()).rejects.toThrow("API failure");
      expect(names(f.issue)).toHaveLength(4);
    },
  );
  it("fails visibly on repeated concurrent changes rather than retrying forever", async () => {
    const f = fixture("open", []);
    f.onAdd(() => {
      f.issue.labels = [];
    });
    f.github.rest.issues.addLabels = async () => {
      f.issue.updated_at += "x";
    };
    await expect(f.run("reopened")).rejects.toThrow(/changed repeatedly/);
  });
});

describe("read-only triage drift report", () => {
  it("includes all paginated issues/labels, excludes PRs, and performs no writes", async () => {
    const report = await reportIssueDrift({
      github: {
        rest: { issues: { listForRepo: "issues", listLabelsForRepo: "labels" } },
        paginate: async (route: string, request: { per_page: number }) => {
          expect(request.per_page).toBe(100);
          if (route === "issues")
            return [
              ...Array.from({ length: 100 }, (_, i) => ({
                number: i + 1,
                state: "open",
                labels: [],
                type: { name: "Task" },
              })),
              { number: 101, state: "closed", labels: [{ name: "needs-triage" }] },
              {
                number: 102,
                state: "closed",
                pull_request: {},
                labels: [{ name: "needs-triage" }],
              },
            ];
          if (route === "labels")
            return [{ name: "legacy-label", color: "000000", description: "old" }];
          return [
            {
              name: "Priority",
              visibility: "organization_members_only",
              options: [{ name: "Urgent" }, { name: "High" }, { name: "Medium" }, { name: "Low" }],
            },
          ];
        },
      },
      context: { repo: { owner: "OpenMapX", repo: "openmapx" } },
    });
    expect(report.closedWorkflowLabels).toEqual([{ number: 101, labels: ["needs-triage"] }]);
    expect(report.unknownLabels).toEqual(["legacy-label"]);
    expect(report.missingLabels).toContain("needs-info");
    expect(report.fieldAccess).toBe("checked");
    expect(report.fieldDrift).toContainEqual({
      name: "Priority",
      expected: "public",
      actual: "organization_members_only",
    });
    expect(report.issueCount).toBe(101);
  });
  it.each([403, 404])(
    "reports org fields as unverified on %s without requesting extra credentials",
    async (status) => {
      const report = await reportIssueDrift({
        github: {
          rest: { issues: { listForRepo: "issues", listLabelsForRepo: "labels" } },
          paginate: async (route: string) => {
            if (route.startsWith("GET ")) throw Object.assign(new Error("Unavailable"), { status });
            return [];
          },
        },
        context: { repo: { owner: "OpenMapX", repo: "openmapx" } },
      });
      expect(report.fieldAccess).toBe("unverified");
      expect(report.fieldDrift).toBeNull();
    },
  );
  it("does not hide org field server failures as access limits", async () => {
    await expect(
      reportIssueDrift({
        github: {
          rest: { issues: { listForRepo: "issues", listLabelsForRepo: "labels" } },
          paginate: async (route: string) => {
            if (route.startsWith("GET "))
              throw Object.assign(new Error("Server failure"), { status: 500 });
            return [];
          },
        },
        context: { repo: { owner: "OpenMapX", repo: "openmapx" } },
      }),
    ).rejects.toThrow("Server failure");
  });
});

function linkReportLabels(issueNumber: string) {
  const links = load(
    readFileSync(new URL("../.github/workflows/links.yml", import.meta.url), "utf8"),
  );
  const value: string = links.jobs.lychee.steps.find((step) => step.with?.labels).with.labels;
  const resolved = value.startsWith("${{")
    ? runInNewContext(
        value.slice(3, -2).replaceAll("steps.find-issue.outputs.issue-number", "issueNumber"),
        { issueNumber },
        { timeout: 1000 },
      )
    : value;
  return resolved.split(/,\s*/);
}

describe("contribution policy consumers", () => {
  it.each([
    ["", ["documentation", "needs-triage"]],
    ["42", ["documentation"]],
  ])(
    "initializes token-created link reports without re-triaging existing issue=%s",
    (issueNumber, expected) => {
      expect(linkReportLabels(issueNumber as string)).toEqual(expected);
    },
  );

  it("keeps every form and bot label within the shared policy", () => {
    const labels = JSON.parse(
      readFileSync(new URL("../.github/labels.json", import.meta.url), "utf8"),
    );
    const names = labels.map((label: { name: string }) => label.name);
    expect(new Set(names).size).toBe(names.length);
    const configs = ["bug_report", "feature_request", "integration_request", "task"].map((name) =>
      load(readFileSync(new URL(`../.github/ISSUE_TEMPLATE/${name}.yml`, import.meta.url), "utf8")),
    );
    const dependabot = load(
      readFileSync(new URL("../.github/dependabot.yml", import.meta.url), "utf8"),
    );
    const references = [
      ...configs.flatMap((form) => form.labels),
      ...dependabot.updates.flatMap((update) => update.labels),
      ...linkReportLabels(""),
      ...linkReportLabels("42"),
    ];
    expect(references.filter((name) => !names.includes(name))).toEqual([]);
    for (const form of configs) expect(["Bug", "Feature", "Task"]).toContain(form.type);
  });
  it("executes the real Actions housekeeping wrapper and restricts write permissions to issue events", async () => {
    expect(workflow.on.issues.types).toEqual(["opened", "reopened", "closed"]);
    expect(workflow.on.pull_request).toBeUndefined();
    expect(workflow.on.issue_comment).toBeUndefined();
    expect(workflow.jobs.housekeeping.permissions).toEqual({ contents: "read", issues: "write" });
    expect(workflow.jobs["drift-report"].permissions).toEqual({ contents: "read", issues: "read" });
    expect(workflow.jobs.housekeeping.if).toContain("github.event_name == 'issues'");
    for (const job of Object.values(workflow.jobs) as {
      if: string;
      steps: { uses?: string; with?: { script?: string; "persist-credentials"?: boolean } }[];
    }[]) {
      expect(job.if).toContain("github.ref == 'refs/heads/main'");
      expect(job.steps[0].with?.["persist-credentials"]).toBe(false);
      for (const step of job.steps) expect(step.uses).toMatch(/@[a-f0-9]{40}$/);
    }
    const script = workflow.jobs.housekeeping.steps.find((step) => step.with?.script).with.script;
    const context = {
      eventName: "issues",
      repo: { owner: "OpenMapX", repo: "openmapx" },
      payload: {
        action: "closed",
        issue: { number: 42, title: "$(touch /not-executed)", body: "untrusted input" },
      },
    };
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      const issue = { state: 'closed', labels: ['needs-triage', 'needs-info', 'blocked', 'integration'].map(name => ({name})) };
      const github = { rest: { issues: {
        get: async () => ({data: structuredClone(issue)}),
        removeLabel: async ({name}) => { issue.labels = issue.labels.filter(label => label.name !== name); }
      } } };
      const context = ${JSON.stringify(context)};
      ${script}
      console.log(JSON.stringify(issue.labels.map(label => label.name)));
    `,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_WORKSPACE: new URL("..", import.meta.url).pathname.replace(/\/$/, ""),
        },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(["integration"]);
  });
});
