/** Local read-only clone of two content-addressed cached repositories. No fetch,
 * reset, pull or submodule mutation of the shared active working tree. */
import { lstatSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectRequiredFeedCredentialKeys } from "./feed-credential-requirements";
export type PinnedCredentialGitRunner = (args: readonly string[], cwd: string) => Promise<string>;
export async function inspectPinnedFeedCredentialKeys(input: {
  catalogDir: string;
  transitousCommit: string;
  atlasCommit: string;
  git: PinnedCredentialGitRunner;
}): Promise<string[]> {
  const unavailable = () => new Error("Pinned catalog credential requirements are unavailable");
  if (!/^[a-f0-9]{40}$/.test(input.transitousCommit) || !/^[a-f0-9]{40}$/.test(input.atlasCommit))
    throw unavailable();
  for (const path of [input.catalogDir, join(input.catalogDir, "transitland-atlas")]) {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw unavailable();
  }
  const root = mkdtempSync(join(tmpdir(), "openmapx-feed-credential-inspect-")),
    checkout = join(root, "catalog");
  try {
    await input.git(
      ["clone", "--shared", "--no-hardlinks", "--no-checkout", "--", input.catalogDir, checkout],
      root,
    );
    let bytes = 0,
      files = 0;
    const checkTree = async (repository: string, commit: string) => {
      const tree = await input.git(["-C", repository, "ls-tree", "-r", "-l", commit], root);
      if (Buffer.byteLength(tree) > 5 * 1024 * 1024) throw unavailable();
      for (const line of tree.split("\n")) {
        if (!line) continue;
        if (/^160000 commit [a-f0-9]{40}\s+-\t/.test(line)) continue;
        const match = /^(100644|100755) blob [a-f0-9]{40}\s+(\d+)\t/.exec(line);
        if (!match) throw unavailable();
        const size = Number(match[2]);
        bytes += size;
        files++;
        if (
          !Number.isSafeInteger(size) ||
          size > 4 * 1024 * 1024 ||
          bytes > 128 * 1024 * 1024 ||
          files > 50000
        )
          throw unavailable();
      }
    };
    await checkTree(checkout, input.transitousCommit);
    const entry = (
      await input.git(
        ["-C", checkout, "ls-tree", input.transitousCommit, "--", "transitland-atlas"],
        root,
      )
    ).trim();
    if (entry !== `160000 commit ${input.atlasCommit}\ttransitland-atlas`) throw unavailable();
    const atlas = join(checkout, "transitland-atlas");
    await input.git(
      [
        "clone",
        "--shared",
        "--no-hardlinks",
        "--no-checkout",
        "--",
        join(input.catalogDir, "transitland-atlas"),
        atlas,
      ],
      root,
    );
    await checkTree(atlas, input.atlasCommit);
    await input.git(
      ["-C", checkout, "checkout", "--detach", "--force", input.transitousCommit],
      root,
    );
    if (
      (await input.git(["-C", checkout, "rev-parse", "HEAD"], root)).trim() !==
      input.transitousCommit
    )
      throw unavailable();
    await input.git(["-C", atlas, "checkout", "--detach", "--force", input.atlasCommit], root);
    if ((await input.git(["-C", atlas, "rev-parse", "HEAD"], root)).trim() !== input.atlasCommit)
      throw unavailable();
    return collectRequiredFeedCredentialKeys(checkout);
  } catch {
    throw unavailable();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
