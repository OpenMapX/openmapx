import type { Command } from "commander";
import { adminFetch } from "../lib/admin-fetch";
import { log, table } from "../lib/output";

// Mirrors the admin Extensions store over HTTP. Loopback short-circuits auth
// in `requireAdmin`; set OPENMAPX_API_URL for a tunneled remote API.
const API = process.env.API_URL ?? process.env.OPENMAPX_API_URL ?? "http://localhost:3001";

interface CatalogView {
  id: string;
  name: string;
  version: string;
  trust?: string;
  installed: boolean;
  hasUpdate: boolean;
  components: { services: number; integrations: number };
}

interface InstalledView {
  id: string;
  name: string;
  installedVersion: string;
  sourceTrust: string;
  hasUpdate: boolean;
  latestVersion: string | null;
  components: Array<{ kind: string; componentId: string }>;
}

function isUrl(s: string): boolean {
  return /^https?:\/\//.test(s);
}

export function registerExtCommands(program: Command): void {
  const ext = program
    .command("ext")
    .description("Browse and manage extensions (the unified store: integrations + services)");

  ext
    .command("browse")
    .description("List catalog extensions")
    .option("-q, --query <text>", "Filter by text")
    .option("--trust <tier>", "Filter by trust (verified|community)")
    .option("--type <kind>", "Filter by component type (service|integration)")
    .action(async (opts: { query?: string; trust?: string; type?: string }) => {
      const sp = new URLSearchParams();
      if (opts.query) sp.set("q", opts.query);
      if (opts.trust) sp.set("trust", opts.trust);
      if (opts.type) sp.set("type", opts.type);
      const res = await adminFetch(`${API}/api/admin/extensions/catalog?${sp}`);
      if (!res.ok) {
        log.err(`HTTP ${res.status}: ${await res.text()}`);
        process.exit(1);
      }
      const { entries } = (await res.json()) as { entries: CatalogView[] };
      if (entries.length === 0) return log.info("(catalog is empty)");
      console.log(
        table(
          [
            { key: "id", header: "ID" },
            { key: "name", header: "Name" },
            { key: "version", header: "Version" },
            { key: "trust", header: "Trust" },
            { key: "parts", header: "Components" },
            { key: "state", header: "State" },
          ],
          entries.map((e) => ({
            id: e.id,
            name: e.name,
            version: e.version,
            trust: e.trust ?? "—",
            parts: `${e.components.services}s/${e.components.integrations}i`,
            state: e.installed ? (e.hasUpdate ? "update" : "installed") : "—",
          })),
        ),
      );
    });

  ext
    .command("list")
    .description("List installed extensions")
    .action(async () => {
      const res = await adminFetch(`${API}/api/admin/extensions/installed`);
      if (!res.ok) {
        log.err(`HTTP ${res.status}: ${await res.text()}`);
        process.exit(1);
      }
      const { extensions } = (await res.json()) as { extensions: InstalledView[] };
      if (extensions.length === 0) return log.info("(no extensions installed)");
      console.log(
        table(
          [
            { key: "id", header: "ID" },
            { key: "version", header: "Version" },
            { key: "trust", header: "Trust" },
            { key: "parts", header: "Components" },
            { key: "update", header: "Update" },
          ],
          extensions.map((e) => ({
            id: e.id,
            version: e.installedVersion,
            trust: e.sourceTrust,
            parts: e.components.map((c) => `${c.kind[0]}:${c.componentId}`).join(", "),
            update: e.hasUpdate ? `→ ${e.latestVersion}` : "—",
          })),
        ),
      );
    });

  ext
    .command("install <idOrUrl>")
    .description("Install an extension by catalog id or by extension.json URL")
    .action(async (idOrUrl: string) => {
      const body = isUrl(idOrUrl) ? { manifestUrl: idOrUrl } : { id: idOrUrl };
      const res = await adminFetch(`${API}/api/admin/extensions/install`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as { jobId?: string; error?: string };
      if (!res.ok) {
        log.err(data.error ?? `HTTP ${res.status}`);
        process.exit(1);
      }
      log.ok(`Install queued (job ${data.jobId}). Track it under Admin → Activity.`);
    });

  ext
    .command("update <id>")
    .description("Update an installed extension to the catalog's current version")
    .action(async (id: string) => {
      const res = await adminFetch(`${API}/api/admin/extensions/update/${id}`, { method: "POST" });
      const data = (await res.json()) as { jobId?: string; error?: string };
      if (!res.ok) {
        log.err(data.error ?? `HTTP ${res.status}`);
        process.exit(1);
      }
      log.ok(`Update queued (job ${data.jobId}).`);
    });

  ext
    .command("remove <id>")
    .description("Uninstall an extension (removes its services and integrations)")
    .action(async (id: string) => {
      const res = await adminFetch(`${API}/api/admin/extensions/${id}`, { method: "DELETE" });
      const data = (await res.json()) as { jobId?: string; error?: string };
      if (!res.ok) {
        log.err(data.error ?? `HTTP ${res.status}`);
        process.exit(1);
      }
      log.ok(`Remove queued (job ${data.jobId}).`);
    });
}
