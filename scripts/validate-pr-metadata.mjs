// biome-ignore-all lint/suspicious/noUndeclaredEnvVars: Trusted uncached metadata workflow.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sha = /^[a-f0-9]{40}$/;
const identity = (pr) =>
  JSON.stringify([pr.number, pr.head?.sha, pr.base?.sha, pr.base?.ref, pr.body, pr.title]);

/** Only trusted default-branch code runs; candidate objects are parser input. */
export async function validatePrMetadata({ repository, number, head }, io) {
  if (
    !/^[\w.-]+\/[\w.-]+$/.test(repository) ||
    !Number.isSafeInteger(number) ||
    number <= 0 ||
    !sha.test(head)
  )
    throw new Error("Invalid PR metadata identity");
  const current = await io.read(repository, number);
  if (current.number !== number || current.head?.sha !== head || !sha.test(current.base?.sha))
    throw new Error("PR metadata identity changed; use the current event");
  await io.fetch(number, current.base.sha, head);
  await io.validate(current);
  const latest = await io.read(repository, number);
  if (identity(latest) !== identity(current))
    throw new Error("PR metadata changed during validation; the newer event must validate");
}

if (import.meta.main) {
  const directory = mkdtempSync(join(tmpdir(), "openmapx-pr-metadata-"));
  const command = (bin, args, options = {}) =>
    execFileSync(bin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      ...options,
    });
  try {
    await validatePrMetadata(
      {
        repository: process.env.GITHUB_REPOSITORY,
        number: Number(process.env.PR_NUMBER),
        head: process.env.PR_HEAD,
      },
      {
        read: (repository, number) =>
          JSON.parse(command("gh", ["api", `repos/${repository}/pulls/${number}`])),
        fetch: (number, base, head) => {
          command("git", ["fetch", "--no-tags", "origin", `pull/${number}/head`]);
          if (command("git", ["rev-parse", "FETCH_HEAD"]).trim() !== head)
            throw new Error("PR head identity changed during fetch");
          command("git", ["fetch", "--no-tags", "origin", base]);
        },
        validate: (pr) => {
          const metadata = join(directory, "pr.json");
          writeFileSync(metadata, JSON.stringify(pr));
          const env = { ...process.env };
          delete env.GH_TOKEN;
          delete env.GITHUB_TOKEN;
          command(
            process.execPath,
            [
              "scripts/check-release-information.mjs",
              "--base",
              pr.base.sha,
              "--head",
              pr.head.sha,
              "--pr-json",
              metadata,
            ],
            { env, stdio: "inherit" },
          );
        },
      },
    );
    console.log("Current PR release information is valid.");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
