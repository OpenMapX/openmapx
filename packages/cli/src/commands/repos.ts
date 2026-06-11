import { createInterface } from "node:readline/promises";
import type { Command } from "commander";
import { adminFetch } from "../lib/admin-fetch";
import { log, table } from "../lib/output";

// Default to localhost where `requireAdmin` short-circuits auth for loopback
// connections. For remote APIs, set OPENMAPX_API_URL — but note the CLI does
// not yet have a session-cookie acquisition flow, so remote use will currently
// require the operator to either run the CLI on the API host or expose a
// local SSH tunnel.
const API = process.env.API_URL ?? process.env.OPENMAPX_API_URL ?? "http://localhost:3001";

interface RepoRow {
  url: string;
  hash: string;
  displayName: string | null;
  lastFetchedAt: string | null;
  lastSha: string | null;
  autoUpdate: boolean;
  createdAt: string;
}

export type AckDecision = "proceed" | "prompt" | "refuse";

/**
 * Decide how `repos add` should obtain risk acknowledgment.
 * - `--yes` given → proceed (operator acknowledged on the command line).
 * - interactive TTY → prompt the operator.
 * - non-interactive without `--yes` → refuse (never silently acknowledge).
 */
export function resolveAckDecision(opts: { yes?: boolean; isTty: boolean }): AckDecision {
  if (opts.yes) return "proceed";
  if (!opts.isTty) return "refuse";
  return "prompt";
}

async function confirmRepoRisk(): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (
      await rl.question(
        "Community service code runs as containers and integration backends run " +
          "in-process with full secrets/env access. Only add repos you trust.\n" +
          "Register this repository? [y/N] ",
      )
    )
      .trim()
      .toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

export function registerReposCommands(program: Command): void {
  const repos = program.command("repos").description("Manage community service repositories");

  repos
    .command("list")
    .description("List registered service repositories")
    .action(async () => {
      const res = await adminFetch(`${API}/api/admin/service-repos`);
      if (!res.ok) {
        log.err(`HTTP ${res.status}: ${await res.text()}`);
        process.exit(1);
      }
      const body = (await res.json()) as { repos: RepoRow[] };
      if (body.repos.length === 0) {
        log.info("(no repositories registered)");
        return;
      }
      console.log(
        table(
          [
            { key: "url", header: "URL" },
            { key: "hash", header: "Hash" },
            { key: "sha", header: "SHA" },
            { key: "fetched", header: "Last fetched" },
          ],
          body.repos.map((r) => ({
            url: r.url,
            hash: r.hash,
            sha: r.lastSha?.slice(0, 8) ?? "—",
            fetched: r.lastFetchedAt ?? "—",
          })),
        ),
      );
    });

  repos
    .command("add <url>")
    .description("Register a community service repository from a Git URL")
    .option("-y, --yes", "Acknowledge that community repo code runs with container/API privileges")
    .action(async (url: string, opts: { yes?: boolean }) => {
      const decision = resolveAckDecision({ yes: opts.yes, isTty: process.stdin.isTTY === true });
      if (decision === "refuse") {
        log.err(
          "Refusing to register without acknowledgment. Re-run with --yes to confirm " +
            "you trust this repo's code (it runs with container/API privileges).",
        );
        process.exit(1);
      }
      if (decision === "prompt") {
        const ok = await confirmRepoRisk();
        if (!ok) {
          log.info("Aborted — repository not registered.");
          return;
        }
      }
      const res = await adminFetch(`${API}/api/admin/service-repos`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, acknowledgeRisks: true }),
      });
      if (!res.ok) {
        log.err(`HTTP ${res.status}: ${await res.text()}`);
        process.exit(1);
      }
      log.ok(`Registered: ${url}`);
    });

  repos
    .command("remove <hash>")
    .description("Unregister a service repository (and remove the local clone)")
    .action(async (hash: string) => {
      const res = await adminFetch(`${API}/api/admin/service-repos/${hash}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        log.err(`HTTP ${res.status}`);
        process.exit(1);
      }
      log.ok(`Removed: ${hash}`);
    });

  repos
    .command("refresh <hash>")
    .description("git fetch + reset --hard a registered repository")
    .action(async (hash: string) => {
      const res = await adminFetch(`${API}/api/admin/service-repos/${hash}/refresh`, {
        method: "POST",
      });
      if (!res.ok) {
        log.err(`HTTP ${res.status}`);
        process.exit(1);
      }
      log.ok(`Refreshed: ${hash}`);
    });
}
