import type { Command } from "commander";
import { log, table } from "../lib/output";

const API = process.env.API_URL ?? "http://localhost:3001";
const ADMIN_TOKEN = process.env.OPENMAPX_ADMIN_TOKEN;

function authHeaders(): Record<string, string> {
  return ADMIN_TOKEN ? { Authorization: `Bearer ${ADMIN_TOKEN}` } : {};
}

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
      const res = await fetch(`${API}/api/admin/service-repos`, { headers: authHeaders() });
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
        headers: { "Content-Type": "application/json", ...authHeaders() },
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
        headers: authHeaders(),
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
        headers: authHeaders(),
      });
      if (!res.ok) {
        log.err(`HTTP ${res.status}`);
        process.exit(1);
      }
      log.ok(`Refreshed: ${hash}`);
    });
}
