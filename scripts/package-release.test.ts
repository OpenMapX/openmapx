// biome-ignore-all lint/suspicious/noTemplateCurlyInString: literal Actions expressions are asserted.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import * as releaseAPI from "./package-release.mjs";
import {
  planPackageRelease,
  preparePackageRelease,
  publishPackageRelease,
} from "./package-release.mjs";

const sha = "a".repeat(40);
const names = ["@openmapx/extension-contracts", "@openmapx/extension-cli"];
function input(operation = "publish") {
  return {
    operation,
    context: {
      repository: "OpenMapX/openmapx",
      sha,
      ref: "refs/heads/main",
      workflowRef: "OpenMapX/openmapx/.github/workflows/package-release.yml@refs/heads/main",
      runId: 100,
      attempt: 1,
    },
    sourceRunId: 90,
    ci: {
      id: 90,
      run_attempt: 2,
      status: "completed",
      conclusion: "success",
      path: ".github/workflows/ci.yml",
      head_sha: sha,
      head_branch: "main",
      event: "push",
      repository: { full_name: "OpenMapX/openmapx" },
      head_repository: { full_name: "OpenMapX/openmapx" },
    },
    versionPr: 40,
    pr: {
      number: 40,
      merged: true,
      merge_commit_sha: "b".repeat(40),
      base: { ref: "main", repo: { full_name: "OpenMapX/openmapx" } },
      head: { sha: "c".repeat(40), repo: { full_name: "OpenMapX/openmapx" } },
    },
    canonical: {
      valid: true,
      mergeSha: "b".repeat(40),
      headSha: "c".repeat(40),
      reachable: true,
      packages: [{ name: names[0], version: "0.1.1" }],
    },
    pending: [],
    packages: names.map((name, i) => ({
      name,
      directory: `packages/extension-${i ? "cli" : "contracts"}`,
      version: i ? "0.1.0" : "0.1.1",
      private: false,
      dependencies: {},
    })),
    toolVersion: "3.0.3",
    nativePlan: {
      version: 1,
      plan: [
        [{ kind: "publish", name: names[0], version: "0.1.1", access: "public", tag: "latest" }],
      ],
    },
  };
}
describe("qualified package batch planning", () => {
  it("selects the canonical batch, keeping the unchanged CLI consumer-only", () => {
    expect(planPackageRelease(input()).selected.map((p: { name: string }) => p.name)).toEqual([
      names[0],
    ]);
  });
  it("qualifies declared bootstrap versions without CI or publication authority", () => {
    const data = input("qualify");
    data.packages[0].version = "0.1.0";
    const batch = planPackageRelease({
      ...data,
      ci: null,
      canonical: null,
      pr: null,
      versionPr: null,
      sourceRunId: null,
      nativePlan: {
        version: 1,
        plan: [
          [
            ...names.map((name) => ({
              kind: "publish",
              name,
              version: "0.1.0",
              access: "public",
              tag: "latest",
            })),
          ],
        ],
      },
    });
    expect(batch.selected).toHaveLength(2);
    expect(batch.operation).toBe("qualify");
  });
  it.each([
    [
      "wrong source",
      (d: ReturnType<typeof input>) => {
        d.ci.head_sha = "d".repeat(40);
      },
    ],
    [
      "wrong workflow",
      (d: ReturnType<typeof input>) => {
        d.ci.path = ".github/workflows/other.yml";
      },
    ],
    [
      "unfinished attempt",
      (d: ReturnType<typeof input>) => {
        d.ci.status = "in_progress";
      },
    ],
    [
      "invalid attempt",
      (d: ReturnType<typeof input>) => {
        d.ci.run_attempt = 0;
      },
    ],
    [
      "PR CI",
      (d: ReturnType<typeof input>) => {
        d.ci.event = "pull_request";
      },
    ],
    [
      "foreign CI",
      (d: ReturnType<typeof input>) => {
        d.ci.head_repository.full_name = "fork/openmapx";
      },
    ],
    [
      "wrong run",
      (d: ReturnType<typeof input>) => {
        d.ci.id++;
      },
    ],
    [
      "unmerged PR",
      (d: ReturnType<typeof input>) => {
        d.pr.merged = false;
      },
    ],
    [
      "wrong base",
      (d: ReturnType<typeof input>) => {
        d.pr.base.ref = "other";
      },
    ],
    [
      "forged marker",
      (d: ReturnType<typeof input>) => {
        d.canonical.valid = false;
      },
    ],
    [
      "unreachable merge",
      (d: ReturnType<typeof input>) => {
        d.canonical.reachable = false;
      },
    ],
    [
      "different PR head",
      (d: ReturnType<typeof input>) => {
        d.canonical.headSha = "e".repeat(40);
      },
    ],
    [
      "different versions",
      (d: ReturnType<typeof input>) => {
        d.packages[0].version = "0.2.0";
      },
    ],
    [
      "pending notes",
      (d: ReturnType<typeof input>) => {
        (d.pending as string[]).push(".changeset/new.md");
      },
    ],
    [
      "changed allowlist",
      (d: ReturnType<typeof input>) => {
        d.packages[0].name = "@other/name";
      },
    ],
    [
      "private package",
      (d: ReturnType<typeof input>) => {
        d.packages[0].private = true;
      },
    ],
    [
      "outside batch",
      (d: ReturnType<typeof input>) => {
        d.nativePlan.plan[0].push({ ...d.nativePlan.plan[0][0], name: names[1], version: "0.1.0" });
      },
    ],
    [
      "tag-only",
      (d: ReturnType<typeof input>) => {
        d.nativePlan.plan[0][0].kind = "tag-only";
      },
    ],
    [
      "duplicate",
      (d: ReturnType<typeof input>) => {
        d.nativePlan.plan[0].push(d.nativePlan.plan[0][0]);
      },
    ],
    [
      "experimental drift",
      (d: ReturnType<typeof input>) => {
        d.toolVersion = "3.0.4";
      },
    ],
    [
      "workflow source",
      (d: ReturnType<typeof input>) => {
        d.context.workflowRef = d.context.workflowRef.replace("main", "other");
      },
    ],
  ] as const)("rejects %s", (_name, mutate) => {
    const data = input();
    mutate(data);
    expect(() => planPackageRelease(data)).toThrow();
  });
  it("fails unsupported future public runtime dependency topology", () => {
    const data = input();
    data.packages[1].dependencies = { [names[0]]: "^0.1.0" };
    expect(() => planPackageRelease(data)).toThrow(/topology/);
  });
});

function portsFixture() {
  const data = input();
  const batch = planPackageRelease(data);
  const candidate = {
    batch,
    hash: "f".repeat(64),
    packages: batch.selected.map((p: { name: string; version: string }) => ({
      ...p,
      path: `/exact/${p.name.split("/")[1]}.tgz`,
      integrity: "sha512-verified",
      sha512: "digest",
    })),
  };
  const published = new Set<string>();
  const ports = {
    inspectSource: vi.fn(async () => data),
    qualify: vi.fn(async () => candidate),
    readCandidate: vi.fn(async () => candidate),
    validateArtifact: vi.fn(async () => {}),
    assertNpm: vi.fn(async () => {}),
    registryVersion: vi.fn(async (p: { name: string }) =>
      published.has(p.name) ? { present: true } : null,
    ),
    verifyPublished: vi.fn(async () => {}),
    readTag: vi.fn(async () => null as string | null),
    publishTarball: vi.fn(async (p: { name: string }) => {
      published.add(p.name);
    }),
    createTag: vi.fn(async () => {}),
    wait: vi.fn(async () => {}),
  };
  return {
    data,
    candidate,
    published,
    ports,
    request: { context: data.context, artifactId: 500, candidateHash: candidate.hash },
  };
}
describe("qualification and protected publishing", () => {
  it("qualification has no publication/tag mutations", async () => {
    const f = portsFixture();
    await preparePackageRelease(f.data, f.ports);
    expect(f.ports.qualify).toHaveBeenCalledOnce();
    expect(f.ports.publishTarball).not.toHaveBeenCalled();
    expect(f.ports.createTag).not.toHaveBeenCalled();
  });
  it("publishes exact approved paths once and verifies again on retry", async () => {
    const f = portsFixture();
    await publishPackageRelease(f.request, f.ports);
    await publishPackageRelease(f.request, f.ports);
    expect(f.ports.publishTarball).toHaveBeenCalledTimes(1);
    expect(f.ports.publishTarball.mock.calls[0][0]).toEqual(f.candidate.packages[0]);
    expect(f.ports.verifyPublished).toHaveBeenCalledTimes(2);
  });
  it.each(["validateArtifact", "assertNpm", "registryVersion", "readTag"] as const)(
    "fails before mutations on rejected %s",
    async (method) => {
      const f = portsFixture();
      f.ports[method].mockRejectedValue(new Error("rejected"));
      await expect(publishPackageRelease(f.request, f.ports)).rejects.toThrow("rejected");
      expect(f.ports.publishTarball).not.toHaveBeenCalled();
      expect(f.ports.createTag).not.toHaveBeenCalled();
    },
  );
  it("rejects a conflicting tag before npm publish", async () => {
    const f = portsFixture();
    f.ports.readTag.mockResolvedValue("e".repeat(40));
    await expect(publishPackageRelease(f.request, f.ports)).rejects.toThrow(/tag/i);
    expect(f.ports.publishTarball).not.toHaveBeenCalled();
  });
  it("does not skip existing conflicting bytes or failed provenance", async () => {
    const f = portsFixture();
    f.published.add(names[0]);
    f.ports.verifyPublished.mockRejectedValue(new Error("provenance or bytes"));
    await expect(publishPackageRelease(f.request, f.ports)).rejects.toThrow(/provenance/);
    expect(f.ports.createTag).not.toHaveBeenCalled();
    expect(f.ports.publishTarball).not.toHaveBeenCalled();
  });
  it("preserves partial publication and retries only the missing item", async () => {
    const f = portsFixture();
    const companion = {
      ...f.candidate.packages[0],
      ...f.data.packages[1],
      path: "/exact/extension-cli.tgz",
    };
    f.candidate.batch.selected.push(f.data.packages[1]);
    f.candidate.packages.push(companion);
    f.ports.publishTarball
      .mockImplementationOnce(async (item) => {
        f.published.add(item.name);
      })
      .mockRejectedValueOnce(new Error("second publish failed"));
    await expect(publishPackageRelease(f.request, f.ports)).rejects.toThrow(
      "second publish failed",
    );
    expect(f.published.has(names[0])).toBe(true);
    expect(f.ports.createTag).not.toHaveBeenCalled();
    await publishPackageRelease(f.request, f.ports);
    expect(f.ports.publishTarball.mock.calls.map(([item]) => item.name)).toEqual([
      names[0],
      names[1],
      names[1],
    ]);
    expect(f.ports.verifyPublished).toHaveBeenCalledTimes(3);
  });
  it("does not retry a publish failure or create tags", async () => {
    const f = portsFixture();
    f.ports.publishTarball.mockRejectedValue(new Error("npm 409"));
    await expect(publishPackageRelease(f.request, f.ports)).rejects.toThrow("npm 409");
    expect(f.ports.publishTarball).toHaveBeenCalledTimes(1);
    expect(f.ports.createTag).not.toHaveBeenCalled();
  });
  it("retains failure after publication if provenance does not verify", async () => {
    const f = portsFixture();
    f.ports.verifyPublished.mockRejectedValue(new Error("no provenance"));
    await expect(publishPackageRelease(f.request, f.ports)).rejects.toThrow("no provenance");
    expect(f.published.has(names[0])).toBe(true);
    expect(f.ports.createTag).not.toHaveBeenCalled();
  });
});

describe("manual package workflow authority", () => {
  it("separates version, qualification and approved OIDC publication", () => {
    const workflow = parse(
      readFileSync(
        resolve(import.meta.dirname, "../.github/workflows/package-release.yml"),
        "utf8",
      ),
    );
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.concurrency["cancel-in-progress"]).toBe(false);
    for (const job of Object.values(workflow.jobs) as { if: string }[])
      expect(job.if).toContain("github.ref == 'refs/heads/main'");
    expect(workflow.jobs.version.permissions).toEqual({
      contents: "write",
      "pull-requests": "write",
    });
    const action = workflow.jobs.version.steps.find((s: { uses?: string }) =>
      s.uses?.startsWith("changesets/action/version@"),
    );
    expect(action.if).toContain("steps.queue.outputs.pending != '0'");
    expect(action.with.script).toBe("node scripts/version-public-packages.mjs");
    expect(Object.keys(action.with).sort()).toEqual([
      "commit-message",
      "pr-base-branch",
      "pr-title",
      "script",
    ]);
    expect(workflow.jobs.qualify.permissions["id-token"]).toBeUndefined();
    expect(workflow.jobs.publish.environment).toBe("named-release");
    expect(workflow.jobs.publish.permissions["id-token"]).toBe("write");
    expect(workflow.jobs.publish.needs).toBe("qualify");
    const download = workflow.jobs.publish.steps.find((s: { uses?: string }) =>
      s.uses?.startsWith("actions/download-artifact@"),
    );
    expect(download.with["artifact-ids"]).toBe("${{ needs.qualify.outputs.artifact_id }}");
    expect(download.with["run-id"]).toBe("${{ github.run_id }}");
    const steps = workflow.jobs.publish.steps.map((s: { run?: string }) => s.run ?? "").join("\n");
    expect(steps).not.toMatch(/pnpm install|\bbuild\b|\bpack\b/);
  });
});

it("shows the selected and consumer-only artifacts plus binding identities before approval", () => {
  const data = input();
  const batch = planPackageRelease(data);
  const summary = releaseAPI.packageCandidateSummary({
    batch,
    hash: "f".repeat(64),
    all: [
      { ...data.packages[0], selected: true, integrity: "sha512-selected" },
      { ...data.packages[1], selected: false, integrity: "sha512-companion" },
    ],
    receipt: { nativePlanSha256: "e".repeat(64), tools: { changesets: "3.0.3" } },
  });
  expect(summary).toContain("consumer-only: @openmapx/extension-cli@0.1.0");
  expect(summary).toContain("selected: @openmapx/extension-contracts@0.1.1");
  expect(summary).toContain(data.context.workflowRef);
  expect(summary).toContain("3.0.3");
  expect(summary).toContain("e".repeat(64));
});
