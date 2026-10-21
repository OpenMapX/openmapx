import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";
import { computePrivacySourceFingerprint } from "../apps/api/privacy-source-fingerprint.mjs";
import { dockerStages, stageInputs } from "./docker-inputs.mjs";
import {
  coversPath,
  createReleasePlan,
  dockerInputs,
  imageFingerprint,
  lockfileSubgraph,
  selectChangedTargets,
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
    ).toEqual(["package.json", "pnpm-lock.yaml", "apps/web", "packages", "assets/*.png"]);
  });
  it("treats the build workflow and the planner's own code as inputs of every image, not ci.yml", () => {
    const readDockerfile = (path: string) =>
      readFileSync(resolve(import.meta.dirname, "..", path), "utf8");
    for (const [path, expected] of [
      [".github/workflows/docker.yml", 7],
      ["scripts/docker-release-plan.mjs", 7],
      ["scripts/docker-inputs.mjs", 7],
      [".github/workflows/ci.yml", 0],
    ] as const) {
      const selected = selectChangedTargets({
        changedPaths: [path],
        readDockerfile,
        candidates: targets,
      });
      expect(selected, path).toHaveLength(expected);
    }
  });
  it("covers only the files a glob matches, and everything below a matched directory", () => {
    const inputs = dockerInputs(
      "COPY --parents packages/*/package.json ./\nCOPY --parents packages/core/ ./\nCOPY a/[ab].txt /b/\n",
      ".",
    );
    expect(inputs).toEqual(["packages/*/package.json", "packages/core", "a"]);
    expect(coversPath(inputs, "packages/web/package.json")).toBe(true);
    expect(coversPath(inputs, "packages/web/src/index.ts")).toBe(false);
    expect(coversPath(inputs, "packages/core/src/index.ts")).toBe(true);
    expect(coversPath(inputs, "packages/package.json")).toBe(false);
    expect(coversPath(["apps/*"], "apps/web/src/page.tsx")).toBe(true);
    expect(coversPath(["file?.txt"], "file1.txt")).toBe(true);
    expect(coversPath(["file?.txt"], "file12.txt")).toBe(false);
    expect(coversPath(["a.b"], "aXb")).toBe(false);
    expect(coversPath(["a.*"], "aXb")).toBe(false);
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

  it("selects pull-request builds from the same Docker inputs as release fingerprints", () => {
    const selected = selectChangedTargets({
      changedPaths: ["packages/mobility-core/src/index.ts"],
      readDockerfile: (path: string) =>
        readFileSync(resolve(import.meta.dirname, "..", path), "utf8"),
    });

    expect(selected).toEqual(["api", "web", "data-manager", "ops-agent", "transitous-runner"]);
    expect(
      selectChangedTargets({
        changedPaths: ["services/ops-agent/privacy-backup/openmapx-backup-subject-export.py"],
        readDockerfile: (path: string) =>
          readFileSync(resolve(import.meta.dirname, "..", path), "utf8"),
      }),
    ).toContain("privacy-backup");
  });
  it.each([
    ["packages/brands/src/index.ts", ["api", "web"]],
    ["packages/brands/package.json", ["api", "web"]],
    ["services/data-manager/src/jobs/example.ts", ["api", "data-manager"]],
    ["services/data-manager/src/transitous-lock.ts", ["api", "data-manager", "ops-agent"]],
  ])("rebuilds only the images that copy %s", (changed, expected) => {
    expect(
      selectChangedTargets({
        changedPaths: [changed],
        readDockerfile: (path: string) =>
          readFileSync(resolve(import.meta.dirname, "..", path), "utf8"),
        candidates: targets,
      }),
    ).toEqual(expected);
  });
});

describe("docs PR validation input coverage", () => {
  it.each([
    "docs/docs/developer/ci-performance.md",
    "docs/Dockerfile",
    "docs/.dockerignore",
    "docs/pnpm-lock.yaml",
    "docs/patches/image-size+2.0.2.patch",
    ".github/workflows/docs.yml",
    ".trivyignore.yaml",
    ".nvmrc",
  ])("retains a single docs target for edits or deletions of %s", (path) => {
    const selected = selectChangedTargets({
      changedPaths: [path],
      readDockerfile: (file: string) =>
        readFileSync(resolve(import.meta.dirname, "..", file), "utf8"),
    });
    expect(selected.filter((target: string) => target === "docs")).toEqual(["docs"]);
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
  it("gives producer attempts distinct identities and accepts older baselines", () => {
    const first = createReleasePlan({ ...options, releaseId: `${revision}-124-1` });
    const next = createReleasePlan({
      ...options,
      releaseId: `${revision}-124-2`,
      previous: { ...baseline(), release: `${revision}-122-1` },
      force: true,
    });
    expect(next.release).not.toBe(first.release);
    expect(next.sourceRevision).toBe(first.sourceRevision);
    expect(next.images.every((image: { rebuild: boolean }) => image.rebuild)).toBe(true);
    expect(() => createReleasePlan({ ...options, releaseId: `${revision}-124-0` })).toThrow();
    expect(() => createReleasePlan({ ...options, releaseId: `${"c".repeat(40)}-124` })).toThrow();
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
  it("keeps the cold-refresh deadline across cached source rebuilds and retries failed refreshes", () => {
    const previous = baseline();
    const changed = tree.map((entry) =>
      entry.path === "apps/api/src/server.ts" ? { ...entry, oid: "0".repeat(40) } : entry,
    );
    const cached = createReleasePlan({
      ...options,
      tree: changed,
      previous,
      now: "2026-09-18T12:00:00.000Z",
    });
    expect(cached.images.find((image: { app: string }) => image.app === "api")).toMatchObject({
      rebuild: true,
      refresh: false,
    });
    expect(cached.buildMetadata.images.api).toMatchObject({
      builtAt: "2026-09-18T12:00:00.000Z",
      coldRefreshedAt: now,
    });
    const published = { ...previous, buildMetadata: cached.buildMetadata };
    for (const attemptAt of ["2026-09-19T12:00:00.000Z", "2026-09-20T12:00:00.000Z"]) {
      // Neither failed attempt advances release-manifest:latest.
      const attempt = createReleasePlan({
        ...options,
        tree: changed,
        previous: published,
        now: attemptAt,
      });
      expect(attempt.images.every((image: { refresh: boolean }) => image.refresh)).toBe(true);
      expect(attempt.buildMetadata.images.api.coldRefreshedAt).toBe(attemptAt);
    }
    const successful = createReleasePlan({
      ...options,
      tree: changed,
      previous: published,
      now: "2026-09-20T12:00:00.000Z",
    });
    const next = createReleasePlan({
      ...options,
      tree: changed,
      previous: { ...previous, buildMetadata: successful.buildMetadata },
      now: "2026-09-21T12:00:00.000Z",
    });
    expect(next.images.every((image: { rebuild: boolean }) => !image.rebuild)).toBe(true);
    expect(next.buildMetadata.images.api.coldRefreshedAt).toBe("2026-09-20T12:00:00.000Z");
  });
  it("cold-builds bootstrap and legacy metadata without guessing a refresh date", () => {
    const bootstrap = createReleasePlan(options);
    expect(bootstrap.images.every((image: { refresh: boolean }) => image.refresh)).toBe(true);
    const previous = baseline();
    for (const metadata of Object.values(previous.buildMetadata.images) as {
      coldRefreshedAt?: string;
    }[]) {
      delete metadata.coldRefreshedAt;
    }
    const migrated = createReleasePlan({ ...options, previous });
    expect(migrated.images.every((image: { refresh: boolean }) => image.refresh)).toBe(true);
    expect(migrated.buildMetadata.images.api.coldRefreshedAt).toBe(now);
  });
  it("refreshes an image with a future cold-refresh clock", () => {
    const previous = baseline();
    previous.buildMetadata.images.api.coldRefreshedAt = "2026-09-13T12:00:00.000Z";
    const plan = createReleasePlan({ ...options, previous });
    expect(
      plan.images
        .filter((image: { refresh: boolean }) => image.refresh)
        .map((image: { app: string }) => image.app),
    ).toEqual(["api"]);
  });
  it.each(["tomorrow", null, ""])("rejects malformed cold-refresh metadata: %s", (value) => {
    const previous = baseline();
    previous.buildMetadata.images.api.coldRefreshedAt = value;
    expect(() => createReleasePlan({ ...options, previous })).toThrow();
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
    expect(sources).toContain("packages/core");
    expect(sources).not.toContain("packages");
    expect(sources).toContain("services/motis/tools/transitous/requirements.txt");
  });
});

describe("lockfile contribution to image fingerprints", () => {
  const lockfileText = (
    overrides: { webVersion?: string; agentVersion?: string; settings?: string } = {},
  ) => `---
lockfileVersion: '9.0'

importers:

  .:
    packageManagerDependencies:
      pnpm:
        specifier: 12.11.2
        version: 12.11.2

packages:

  pnpm@12.11.2:
    resolution: {integrity: sha512-pnpm}

snapshots:

  pnpm@12.11.2: {}

---
lockfileVersion: '9.0'

settings:
  autoInstallPeers: ${overrides.settings ?? "true"}

importers:

  .:
    devDependencies:
      typescript:
        specifier: ^6.0.0
        version: 6.0.3

  apps/agent:
    dependencies:
      '@openmapx/core':
        specifier: workspace:^
        version: link:../../packages/core
      fastify:
        specifier: ^5.0.0
        version: ${overrides.agentVersion ?? "5.1.0"}

  apps/web:
    dependencies:
      next:
        specifier: ^16.0.0
        version: ${overrides.webVersion ?? "16.0.0(react@19.0.0)"}

  packages/core:
    dependencies:
      zod:
        specifier: ^4.0.0
        version: 4.1.0
      string-width-cjs:
        specifier: npm:string-width@^4.2.3
        version: string-width@4.2.3

packages:

  fastify@5.1.0:
    resolution: {integrity: sha512-fastify510}

  fastify@5.2.0:
    resolution: {integrity: sha512-fastify520}

  next@16.0.0:
    resolution: {integrity: sha512-next}

  next@16.1.0:
    resolution: {integrity: sha512-next161}

  react@19.0.0:
    resolution: {integrity: sha512-react}

  string-width@4.2.3:
    resolution: {integrity: sha512-sw}

  typescript@6.0.3:
    resolution: {integrity: sha512-ts}

  zod@4.1.0:
    resolution: {integrity: sha512-zod}

  zod@4.2.0:
    resolution: {integrity: sha512-zod420}

snapshots:

  fastify@5.1.0: {}

  fastify@5.2.0: {}

  next@16.0.0(react@19.0.0):
    dependencies:
      react: 19.0.0

  next@16.1.0(react@19.0.0):
    dependencies:
      react: 19.0.0

  react@19.0.0: {}

  string-width@4.2.3: {}

  typescript@6.0.3: {}

  zod@4.1.0: {}

  zod@4.2.0: {}
`;
  const documents = (text: string) => parseAllDocuments(text).map((document) => document.toJS());
  const agent = (importer: string) => [".", "apps/agent"].includes(importer);

  it("ignores dependency changes in importers the image does not install", () => {
    const base = lockfileSubgraph(documents(lockfileText()), agent);
    expect(
      lockfileSubgraph(documents(lockfileText({ webVersion: "16.1.0(react@19.0.0)" })), agent),
    ).toBe(base);
  });

  it("changes when a dependency the image installs changes, directly or through a workspace link", () => {
    const base = lockfileSubgraph(documents(lockfileText()), agent);
    expect(lockfileSubgraph(documents(lockfileText({ agentVersion: "5.2.0" })), agent)).not.toBe(
      base,
    );
    // packages/core is not selected itself; the image reaches it through its link.
    const linked = lockfileText().replace("        version: 4.1.0\n", "        version: 4.2.0\n");
    expect(lockfileSubgraph(documents(linked), agent)).not.toBe(base);
    const missing = lockfileText().replace(
      "version: 4.1.0\n",
      "version: 4.1.0\n      extra:\n        specifier: ^1.0.0\n        version: 1.0.0\n",
    );
    expect(() => lockfileSubgraph(documents(missing), agent)).toThrow(
      "Missing snapshot extra@1.0.0",
    );
    expect(lockfileSubgraph(documents(lockfileText({ settings: "false" })), agent)).not.toBe(base);
  });

  it("falls back to the whole lockfile when it cannot follow an entry", () => {
    const tree = [
      { path: "apps/agent/src/index.ts", mode: "100644", oid: "1".repeat(40) },
      { path: "pnpm-lock.yaml", mode: "100644", oid: "2".repeat(40) },
    ];
    const target = { app: "agent", context: ".", dockerfile: "Dockerfile" };
    const readDockerfile = () =>
      "FROM scratch\nCOPY package.json pnpm-lock.yaml ./\nCOPY apps/agent/ /app\n";
    const fallbacks: string[] = [];
    const fingerprint = (text: string, oid = "2".repeat(40)) =>
      imageFingerprint({
        target,
        tree: tree.map((entry) => (entry.path === "pnpm-lock.yaml" ? { ...entry, oid } : entry)),
        readDockerfile,
        privacyFingerprint: privacy,
        lockfile: { documents: documents(text) },
        onLockfileFallback: (app: string) => fallbacks.push(app),
      });
    const base = fingerprint(lockfileText());
    expect(fingerprint(lockfileText({ webVersion: "16.1.0(react@19.0.0)" }), "3".repeat(40))).toBe(
      base,
    );
    expect(fallbacks).toEqual([]);
    expect(fingerprint("lockfileVersion: '9.0'\n", "4".repeat(40))).not.toBe(base);
    expect(fallbacks).toEqual(["agent"]);
  });

  it("follows every snapshot of the repository's lockfile", () => {
    const text = readFileSync(resolve(import.meta.dirname, "../pnpm-lock.yaml"), "utf8");
    expect(() => lockfileSubgraph(documents(text), () => true)).not.toThrow();
  });
});

describe("bundled image fingerprints", () => {
  const dockerfile = [
    "FROM node AS base",
    "COPY package.json /tmp/package.json",
    "FROM base AS deps",
    "COPY package.json pnpm-lock.yaml ./",
    "COPY packages/lib/package.json packages/lib/",
    "COPY apps/runner/package.json apps/runner/",
    "RUN pnpm install --frozen-lockfile",
    "FROM base AS prod-deps",
    "COPY package.json pnpm-lock.yaml ./",
    "COPY packages/lib/package.json packages/lib/",
    "COPY apps/runner/package.json apps/runner/",
    "RUN pnpm install --frozen-lockfile --prod",
    "FROM deps AS bundle",
    "COPY packages/lib/ packages/lib/",
    "COPY apps/runner/ apps/runner/",
    "RUN node build.mjs",
    "FROM base AS runner",
    "COPY --from=prod-deps /app/node_modules ./node_modules",
    "COPY --from=bundle /app/apps/runner/dist ./dist",
    "COPY config/runtime.json ./",
  ].join("\n");
  const target = { app: "runner", context: ".", dockerfile: "apps/runner/Dockerfile" };
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ packageManager: "pnpm@12.11.2", scripts: { a: "1" } }),
    "packages/lib/package.json": JSON.stringify({
      name: "lib",
      version: "1.0.0",
      dependencies: { zod: "^4" },
    }),
    "apps/runner/package.json": JSON.stringify({ name: "runner", scripts: { start: "x" } }),
    "packages/lib/src/index.ts": "export const a = 1;",
    "apps/runner/src/index.ts": "console.log(1);",
    "config/runtime.json": "{}",
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
  };
  const fingerprint = (overrides: Record<string, string> = {}, bundleDigest = "a".repeat(64)) => {
    const contents = { ...files, ...overrides };
    return imageFingerprint({
      target,
      tree: Object.entries(contents).map(([path, text]) => ({
        path,
        mode: "100644",
        oid: createHash("sha1").update(text).digest("hex"),
      })),
      readDockerfile: () => dockerfile,
      privacyFingerprint: privacy,
      bundleDigest,
      readFile: (path: string) => contents[path],
    });
  };

  it("follows the stages the runner is built from, without entering the bundle stage", () => {
    const { inputs, reachesReplaced } = stageInputs(dockerfile, ".", "bundle");
    expect(reachesReplaced).toBe(true);
    expect(inputs.sort()).toEqual(
      [
        "apps/runner/package.json",
        "config/runtime.json",
        "package.json",
        "packages/lib/package.json",
        "pnpm-lock.yaml",
      ].sort(),
    );
    // From the bundle stage itself: what a partial checkout gives the bundler.
    expect(stageInputs(dockerfile, ".", undefined, "bundle").inputs.sort()).toEqual(
      [
        "apps/runner",
        "apps/runner/package.json",
        "package.json",
        "packages/lib",
        "packages/lib/package.json",
        "pnpm-lock.yaml",
      ].sort(),
    );
    expect(dockerStages(dockerfile).map((stage: { name?: string }) => stage.name)).toEqual([
      "base",
      "deps",
      "prod-deps",
      "bundle",
      "runner",
    ]);
  });

  it("ignores source edits that leave the bundle unchanged and follows the bundle digest", () => {
    const base = fingerprint();
    expect(fingerprint({ "packages/lib/src/index.ts": "export const a = 2;" })).toBe(base);
    expect(fingerprint({ "apps/runner/src/index.ts": "console.log(2);" })).toBe(base);
    expect(fingerprint({}, "b".repeat(64))).not.toBe(base);
    expect(fingerprint({ "config/runtime.json": '{"changed":true}' })).not.toBe(base);
  });

  it("counts only what a production install reads from the manifests", () => {
    const base = fingerprint();
    const manifest = (value: object) => JSON.stringify(value);
    expect(
      fingerprint({
        "package.json": manifest({ packageManager: "pnpm@12.11.2", scripts: { a: "2" } }),
      }),
    ).toBe(base);
    expect(
      fingerprint({
        "packages/lib/package.json": manifest({
          name: "lib",
          version: "2.0.0",
          dependencies: { zod: "^4" },
        }),
      }),
    ).toBe(base);
    expect(
      fingerprint({
        "packages/lib/package.json": manifest({
          name: "lib",
          version: "1.0.0",
          dependencies: { zod: "^5" },
        }),
      }),
    ).not.toBe(base);
    expect(
      fingerprint({
        "package.json": manifest({ packageManager: "pnpm@12.12.0", scripts: { a: "1" } }),
      }),
    ).not.toBe(base);
  });

  it("refuses a bundled image whose runner does not use a bundle stage", () => {
    expect(() =>
      imageFingerprint({
        target,
        tree: [],
        readDockerfile: () => "FROM node AS runner\nCOPY a ./\n",
        privacyFingerprint: privacy,
        bundleDigest: "a".repeat(64),
        readFile: () => "",
      }),
    ).toThrow('no stage named "bundle"');
  });

  it("records the bundle digest for the release build, which checks it", () => {
    const root = resolve(import.meta.dirname, "..");
    const plan = createReleasePlan({
      ...options,
      tree: trackedTree(root),
      readDockerfile: (path: string) => readFileSync(resolve(root, path), "utf8"),
      bundleDigests: { "transitous-runner": "c".repeat(64) },
      readFile: (path: string) => readFileSync(resolve(root, path), "utf8"),
    });
    expect(
      plan.images.find((image: { app: string }) => image.app === "transitous-runner"),
    ).toMatchObject({ bundleDigest: "c".repeat(64) });
    const workflow = readFileSync(resolve(root, ".github/workflows/docker.yml"), "utf8");
    expect(workflow).toContain(
      "format('EXPECTED_BUNDLE_DIGEST={0}', steps.selection.outputs.bundle_digest)",
    );
    expect(readFileSync(resolve(root, "apps/transitous-runner/Dockerfile"), "utf8")).toMatch(
      /ARG EXPECTED_BUNDLE_DIGEST=\nRUN node scripts\/build-runtime-bundles\.mjs transitous-runner --expect "\$EXPECTED_BUNDLE_DIGEST"/,
    );
  });
});
