import type { services as coreServices } from "@openmapx/core/server";
import { execa } from "execa";

/**
 * Where the host's checkout stands against the selected release, by git: at
 * or behind the release's source revision, or not (ahead, on another line,
 * or unknown). Only at or behind may a checkout file that matches no version
 * the release shipped be taken for the operator's edit. The operator's own
 * command asks git; the agent never does.
 */
export async function checkoutPositionFromGit(
  rootDir: string,
  revision: string | null,
): Promise<coreServices.CheckoutPosition> {
  if (!revision) {
    return {
      atOrBehindRelease: false,
      reason:
        "the selected release's operations-agent image names no source revision to compare the checkout with",
    };
  }
  const run = await execa("git", ["-C", rootDir, "merge-base", "--is-ancestor", "HEAD", revision], {
    reject: false,
    timeout: 30_000,
  });
  if (run.exitCode === 0) return { atOrBehindRelease: true };
  if (run.exitCode === 1) {
    return {
      atOrBehindRelease: false,
      reason: `the checkout's commit is neither the release's source revision ${revision} nor one before it`,
    };
  }
  const detail =
    String(run.stderr ?? "")
      .trim()
      .split("\n")
      .slice(-1)[0] || `exit ${run.exitCode ?? "unknown"}`;
  return {
    atOrBehindRelease: false,
    reason: `git could not compare the checkout with the release's source revision ${revision} (${detail}); \`git fetch origin\` brings that revision if it is missing`,
  };
}
