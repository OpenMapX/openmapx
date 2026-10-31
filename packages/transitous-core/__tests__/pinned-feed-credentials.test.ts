import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { inspectPinnedFeedCredentialKeys } from "../src/pinned-feed-credentials";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
const run = (cwd: string, args: readonly string[]) =>
  execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "OpenMapX fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.test",
      GIT_COMMITTER_NAME: "OpenMapX fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.test",
    },
  }).trim();
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "omx-pinned-credential-fixture-"));
  roots.push(root);
  const atlas = join(root, "transitland-atlas");
  mkdirSync(join(root, "feeds"));
  mkdirSync(join(atlas, "feeds"), { recursive: true });
  run(root, ["init"]);
  run(atlas, ["init"]);
  writeFileSync(
    join(atlas, "feeds/a.dmfr.json"),
    JSON.stringify({ feeds: [{ id: "auth", authorization: { type: "api-key" } }] }),
  );
  run(atlas, ["add", "."]);
  run(atlas, ["commit", "-m", "Atlas A"]);
  const atlasCommit = run(atlas, ["rev-parse", "HEAD"]);
  writeFileSync(
    join(root, "feeds/de.json"),
    JSON.stringify({ sources: [{ name: "A", "transitland-atlas-id": "auth" }] }),
  );
  run(root, ["add", "feeds"]);
  run(root, ["update-index", "--add", "--cacheinfo", `160000,${atlasCommit},transitland-atlas`]);
  run(root, ["commit", "-m", "Transitous A"]);
  const transitousCommit = run(root, ["rev-parse", "HEAD"]);
  writeFileSync(
    join(root, "feeds/de.json"),
    JSON.stringify({ sources: [{ name: "B", "transitland-atlas-id": "auth" }] }),
  );
  run(root, ["add", "feeds"]);
  run(root, ["commit", "-m", "Transitous B"]);
  return { root, atlasCommit, transitousCommit };
}
it("reads actual pin A while active cache is at B without resetting/pulling the cache", async () => {
  const f = fixture(),
    before = readFileSync(join(f.root, "feeds/de.json")),
    head = run(f.root, ["rev-parse", "HEAD"]),
    calls: readonly string[][] = [];
  const keys = await inspectPinnedFeedCredentialKeys({
    catalogDir: f.root,
    transitousCommit: f.transitousCommit,
    atlasCommit: f.atlasCommit,
    git: async (args, cwd) => {
      (calls as string[][]).push([...args]);
      return run(cwd, args);
    },
  });
  expect(keys).toEqual(["de/A"]);
  expect(readFileSync(join(f.root, "feeds/de.json"))).toEqual(before);
  expect(run(f.root, ["rev-parse", "HEAD"])).toBe(head);
  expect(calls.flat()).not.toContain("pull");
  expect(calls.flat()).not.toContain("reset");
});
it("rejects a foreign atlas pin or unavailable commit without touching the cache", async () => {
  const f = fixture(),
    head = run(f.root, ["rev-parse", "HEAD"]);
  await expect(
    inspectPinnedFeedCredentialKeys({
      catalogDir: f.root,
      transitousCommit: f.transitousCommit,
      atlasCommit: "b".repeat(40),
      git: async (args, cwd) => run(cwd, args),
    }),
  ).rejects.toThrow(/unavailable/);
  expect(run(f.root, ["rev-parse", "HEAD"])).toBe(head);
});

it.each(["oversize", "symlink"])("refuses %s repository content before checkout", async (kind) => {
  const f = fixture();
  if (kind === "oversize")
    writeFileSync(join(f.root, "large.dat"), Buffer.alloc(4 * 1024 * 1024 + 1, 120));
  else symlinkSync("../../outside", join(f.root, "feeds/linked.json"));
  run(f.root, ["add", "."]);
  run(f.root, ["commit", "-m", "Rejected content"]);
  const sha = run(f.root, ["rev-parse", "HEAD"]);
  let checkouts = 0;
  await expect(
    inspectPinnedFeedCredentialKeys({
      catalogDir: f.root,
      transitousCommit: sha,
      atlasCommit: f.atlasCommit,
      git: async (args, cwd) => {
        if (args.includes("checkout")) checkouts++;
        return run(cwd, args);
      },
    }),
  ).rejects.toThrow(/unavailable/);
  expect(checkouts).toBe(0);
});

it("inspects a newly fetched Atlas pin in a shallow cache without moving either shared HEAD", async () => {
  const f = fixture(),
    atlas = join(f.root, "transitland-atlas"),
    remote = join(f.root, "atlas-remote.git"),
    work = join(f.root, "atlas-work");
  run(f.root, ["clone", "--bare", atlas, remote]);
  run(f.root, ["clone", remote, work]);
  writeFileSync(
    join(work, "feeds/a.dmfr.json"),
    JSON.stringify({
      feeds: [
        { id: "auth", authorization: { type: "api-key" }, license: { name: "New pinned terms" } },
      ],
    }),
  );
  run(work, ["add", "."]);
  run(work, ["commit", "-m", "Atlas B"]);
  const next = run(work, ["rev-parse", "HEAD"]);
  run(work, ["push", "origin", "HEAD"]);
  run(atlas, ["fetch", "--depth=1", "--no-tags", remote, next]);
  run(f.root, ["update-index", "--cacheinfo", `160000,${next},transitland-atlas`]);
  run(f.root, ["commit", "-m", "New Atlas pin"]);
  const head = run(f.root, ["rev-parse", "HEAD"]),
    atlasHead = run(atlas, ["rev-parse", "HEAD"]);
  const failures: Array<{ args: readonly string[]; stderr: string }> = [];
  try {
    expect(
      await inspectPinnedFeedCredentialKeys({
        catalogDir: f.root,
        transitousCommit: head,
        atlasCommit: next,
        git: async (args, cwd) => {
          try {
            return run(cwd, args);
          } catch (error) {
            failures.push({ args, stderr: String((error as { stderr?: unknown }).stderr ?? "") });
            throw error;
          }
        },
      }),
    ).toEqual(["de/B"]);
  } catch (error) {
    console.info("Synthetic Git failure only", JSON.stringify(failures));
    throw error;
  }
  expect(run(f.root, ["rev-parse", "HEAD"])).toBe(head);
  expect(run(atlas, ["rev-parse", "HEAD"])).toBe(atlasHead);
});
