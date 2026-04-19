import type { Command } from "commander";
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

export function registerReposCommands(program: Command): void {
  const repos = program.command("repos").description("Manage community service repositories");

  repos
    .command("list")
    .description("List registered service repositories")
    .action(async () => {
      const res = await fetch(`${API}/api/admin/service-repos`);
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
    .action(async (url: string) => {
      const res = await fetch(`${API}/api/admin/service-repos`, {
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
      const res = await fetch(`${API}/api/admin/service-repos/${hash}`, {
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
      const res = await fetch(`${API}/api/admin/service-repos/${hash}/refresh`, {
        method: "POST",
      });
      if (!res.ok) {
        log.err(`HTTP ${res.status}`);
        process.exit(1);
      }
      log.ok(`Refreshed: ${hash}`);
    });
}
