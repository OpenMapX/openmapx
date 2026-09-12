import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { computePrivacySourceFingerprint } from "../apps/api/privacy-source-fingerprint.mjs";
import {
  createReleasePlan,
  dockerInputs,
  imageFingerprint,
  targets,
  trackedTree,
} from "./docker-release-plan.mjs";

const revision = "b".repeat(40);
const now = "2026-09-12T12:00:00.000Z";
const privacy = "f".repeat(64);
const tree = [
  ["apps/api/src/server.ts", "api"],
  ["apps/web/src/page.tsx", "web"],
  ["packages/shared/index.ts", "shared"],
  ["docs/page.md", "docs"],
  ["pnpm-lock.yaml", "lock"],
  ["README.md", "readme"],
].map(([path, contents]) => ({
  path,
  mode: "100644",
  oid: createHash("sha1").update(contents).digest("hex"),
}));
const dockerfiles: Record<string, string> = Object.fromEntries(
  targets.map((target: { app: string; dockerfile: string }) => [
    target.dockerfile,
    target.app === "docs"
      ? "FROM scratch\nCOPY . /docs\n"
      : target.app === "privacy-backup"
        ? "FROM scratch\nCOPY services/ops-agent/privacy-backup/ /app\n"
        : target.app === "transitous-tools"
          ? "FROM scratch\nCOPY requirements.txt /app\n"
          : `FROM scratch\nCOPY apps/${target.app}/ /app\nCOPY packages/ /packages\nCOPY pnpm-lock.yaml /app/\n`,
  ]),
);
const options = {
  revision,
  now,
  tree,
  privacyFingerprint: privacy,
  readDockerfile: (path: string) => dockerfiles[path],
};

function baseline() {
  const plan = createReleasePlan(options);
  return {
    schemaVersion: 1,
    release: revision,
    images: Object.fromEntries(
      targets.map((target: { app: string }, i: number) => [
        target.app,
        `ghcr.io/openmapx/${target.app}@sha256:${String(i + 1).repeat(64)}`,
      ]),
    ),
    privacyReleaseValidation: { sourceBuildFingerprint: privacy },
    buildMetadata: plan.buildMetadata,
  };
}

describe("Dockerfile build input coverage", () => {
  it("covers sources across stages, including JSON, flags, globs and directories", () => {
    expect(
      dockerInputs(
        'FROM scratch\nCOPY --chown=1:1 package.json pnpm-lock.yaml /app/\nCOPY ["apps/web/", "/app/"]\nCOPY --exclude=*/package.json packages/ /app/\nCOPY assets/*.png /assets/\nCOPY --from=build /app /runtime\n',
        ".",
      ),
    ).toEqual(["package.json", "pnpm-lock.yaml", "apps/web", "packages", "assets"]);
  });
  it.each([
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Docker build argument syntax.
    "COPY ${SOURCE} /app",
    "RUN --mount=type=bind,target=/src make",
    "COPY <<EOF /app",
    "ONBUILD COPY hidden /app",
    "COPY --unknown=value src /app",
  ])("uses the whole context for unsupported input syntax: %s", (instruction) => {
    expect(dockerInputs(`FROM scratch\n${instruction}\n`, "docs")).toEqual(["docs"]);
  });
  it("keeps a literal COPY source containing parentheses", () => {
    expect(dockerInputs("COPY apps/web/src/app/(legal)/ /app\n", ".")).toEqual([
      "apps/web/src/app/(legal)",
    ]);
  });
});

describe("selective release planning", () => {
  it("bootstraps all seven builds without a previous release or legacy build metadata", () => {
    expect(
      createReleasePlan(options).images.every((image: { rebuild: boolean }) => image.rebuild),
    ).toBe(true);
    const previous = baseline();
    delete (previous as { buildMetadata?: unknown }).buildMetadata;
    expect(
      createReleasePlan({ ...options, previous }).images.every(
        (image: { rebuild: boolean }) => image.rebuild,
      ),
    ).toBe(true);
  });
  it.each([`ghcr.io/openmapx/docs@sha256:${"a".repeat(64)}`, "ghcr.io/openmapx/docs:latest"])(
    "ignores unrelated docs image metadata in a previous release (%s)",
    (docs) => {
      const previous = baseline();
      const plan = createReleasePlan({
        ...options,
        previous: { ...previous, images: { ...previous.images, docs } },
      });
      expect(plan).toEqual(createReleasePlan({ ...options, previous }));
    },
  );
  it("reuses all unchanged digests despite a new release revision", () => {
    const previous = baseline();
    const plan = createReleasePlan({ ...options, revision: "c".repeat(40), previous });
    expect(plan.images.map((image: { rebuild: boolean }) => image.rebuild)).toEqual(
      Array(7).fill(false),
    );
    expect(plan.buildMetadata).toEqual(previous.buildMetadata);
    expect(plan.images.find((image: { app: string }) => image.app === "api").digest).toBe(
      `sha256:${"1".repeat(64)}`,
    );
  });
  it("gives refreshes of the same commit distinct release identities while accepting older baselines", () => {
    const first = createReleasePlan({ ...options, releaseId: `${revision}-123-1` });
    const next = createReleasePlan({
      ...options,
      releaseId: `${revision}-124-1`,
      previous: { ...baseline(), release: first.release },
      force: true,
    });
    expect(next.release).not.toBe(first.release);
    expect(next.sourceRevision).toBe(first.sourceRevision);
    expect(next.images.every((image: { rebuild: boolean }) => image.rebuild)).toBe(true);
    expect(() => createReleasePlan({ ...options, releaseId: `${"c".repeat(40)}-124-1` })).toThrow();
  });
  it("does not rebuild application images for a docs edit", () => {
    const changed = tree.map((entry) =>
      entry.path === "docs/page.md" ? { ...entry, oid: "0".repeat(40) } : entry,
    );
    const plan = createReleasePlan({ ...options, tree: changed, previous: baseline() });
    expect(
      plan.images
        .filter((image: { rebuild: boolean }) => image.rebuild)
        .map((image: { app: string }) => image.app),
    ).toEqual([]);
  });
  it.each(["packages/shared/index.ts", "pnpm-lock.yaml"])(
    "rebuilds every root app copying %s",
    (path) => {
      const changed = tree.map((entry) =>
        entry.path === path ? { ...entry, oid: "0".repeat(40) } : entry,
      );
      const plan = createReleasePlan({ ...options, tree: changed, previous: baseline() });
      expect(
        plan.images
          .filter((image: { rebuild: boolean }) => image.rebuild)
          .map((image: { app: string }) => image.app),
      ).toEqual(["api", "web", "data-manager", "ops-agent", "transitous-runner"]);
    },
  );
  it("compares to the successful release, retaining changes from an intervening failed release", () => {
    const previous = baseline();
    const changed = tree.filter((entry) => entry.path !== "apps/api/src/server.ts");
    const failed = createReleasePlan({
      ...options,
      revision: "c".repeat(40),
      tree: changed,
      previous,
    });
    const next = createReleasePlan({
      ...options,
      revision: "d".repeat(40),
      tree: changed,
      previous,
    });
    expect(next.images.find((image: { app: string }) => image.app === "api").rebuild).toBe(true);
    expect(next.buildMetadata.images.api.inputHash).toBe(failed.buildMetadata.images.api.inputHash);
  });
  it("rebuilds API when privacy evidence changes, even with identical Docker inputs", () => {
    const plan = createReleasePlan({
      ...options,
      privacyFingerprint: "e".repeat(64),
      previous: baseline(),
    });
    expect(
      plan.images
        .filter((image: { rebuild: boolean }) => image.rebuild)
        .map((image: { app: string }) => image.app),
    ).toEqual(["api"]);
  });
  it("preserves original build age on reuse and refreshes without cache after seven days", () => {
    const previous = baseline();
    const reused = createReleasePlan({ ...options, now: "2026-09-18T12:00:00.000Z", previous });
    expect(reused.buildMetadata.images.api.builtAt).toBe(now);
    const refreshed = createReleasePlan({
      ...options,
      now: "2026-09-19T12:00:00.000Z",
      previous: { ...previous, buildMetadata: reused.buildMetadata },
    });
    expect(
      refreshed.images.every(
        (image: { rebuild: boolean; refresh: boolean }) => image.rebuild && image.refresh,
      ),
    ).toBe(true);
  });
  it("forces no-cache rebuilds on request", () => {
    expect(
      createReleasePlan({ ...options, previous: baseline(), force: true }).images.every(
        (image: { refresh: boolean }) => image.refresh,
      ),
    ).toBe(true);
  });
  it.each(["tag", "missing", "metadata", "timestamp"])("rejects invalid baseline %s", (kind) => {
    const previous = baseline();
    if (kind === "tag") previous.images.api = "ghcr.io/openmapx/api:latest";
    if (kind === "missing") delete previous.images.api;
    if (kind === "metadata") previous.buildMetadata.images.api.inputHash = "bad";
    if (kind === "timestamp") previous.buildMetadata.images.api.builtAt = "tomorrow";
    expect(() => createReleasePlan({ ...options, previous })).toThrow();
  });
  it("includes file names and modes, so renames and executable changes invalidate inputs", () => {
    const target = targets[0];
    const hash = imageFingerprint({ ...options, target });
    for (const changed of [
      tree.map((entry) => ({ ...entry, path: `${entry.path}.renamed` })),
      tree.map((entry) => ({ ...entry, mode: "100755" })),
    ]) {
      expect(imageFingerprint({ ...options, target, tree: changed })).not.toBe(hash);
    }
  });
  it("keeps the planner's targets identical to the static publishing matrix", () => {
    const workflow = readFileSync(
      resolve(import.meta.dirname, "../.github/workflows/docker.yml"),
      "utf8",
    );
    const matrix = [
      ...workflow.matchAll(/ {10}- app: (.+)\n {12}context: (.+)\n {12}dockerfile: (.+)/g),
    ].map((match) => ({ app: match[1], context: match[2], dockerfile: match[3] }));
    expect(targets).toEqual(matrix);
  });
  it("covers the actual repository's copied inputs and privacy coupling", async () => {
    const root = resolve(import.meta.dirname, "..");
    const actual = {
      ...options,
      tree: trackedTree(root),
      readDockerfile: (path: string) => readFileSync(resolve(root, path), "utf8"),
      privacyFingerprint: await computePrivacySourceFingerprint(root),
    };
    const plan = createReleasePlan(actual);
    expect(plan.images).toHaveLength(7);
    const changedTree = actual.tree.map((entry: { path: string; oid: string; mode: string }) =>
      entry.path === "docs/docs/install/upgrading.md" ? { ...entry, oid: "0".repeat(40) } : entry,
    );
    expect(changedTree).not.toEqual(actual.tree);
    const previous = {
      ...baseline(),
      buildMetadata: plan.buildMetadata,
      privacyReleaseValidation: { sourceBuildFingerprint: actual.privacyFingerprint },
    };
    const docsOnly = createReleasePlan({ ...actual, tree: changedTree, previous });
    expect(
      docsOnly.images
        .filter((image: { rebuild: boolean }) => image.rebuild)
        .map((image: { app: string }) => image.app),
    ).toEqual([]);

    const sources = dockerInputs(actual.readDockerfile("apps/transitous-runner/Dockerfile"), ".");
    expect(sources).toContain("packages");
    expect(sources).toContain("services/motis/tools/transitous/requirements.txt");
  });
});
