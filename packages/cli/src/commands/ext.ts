import {
  installAdminExtension,
  listAdminExtensionCatalog,
  listAdminInstalledExtensions,
  previewAdminExtensionInstall,
  removeAdminExtension,
  unwrapAdminResponse,
  updateAdminExtension,
} from "@openmapx/core/api-admin-sdk";
import type { Command } from "commander";
import {
  createExtensionAdminClient,
  EXTENSION_READ_TIMEOUT_MS,
  EXTENSION_RESOLUTION_TIMEOUT_MS,
  printExtensionPreview,
  requireHostPortReview,
  runExtensionAction,
} from "../lib/extension-admin";
import { log, table } from "../lib/output";

function selector(idOrUrl: string) {
  return /^https?:\/\//.test(idOrUrl) ? { manifestUrl: idOrUrl } : { id: idOrUrl };
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
    .action((opts: { query?: string; trust?: string; type?: string }) =>
      runExtensionAction(async () => {
        const client = createExtensionAdminClient();
        const { entries } = unwrapAdminResponse(
          await listAdminExtensionCatalog(
            { q: opts.query, trust: opts.trust, type: opts.type },
            { client, timeoutMs: EXTENSION_READ_TIMEOUT_MS },
          ),
        );
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
              version: e.version ?? "Version unknown",
              trust: e.trust ?? "—",
              parts: `${e.components.services}s/${e.components.integrations}i`,
              state: e.installed ? (e.hasUpdate ? "update" : "installed") : "—",
            })),
          ),
        );
      }),
    );

  ext
    .command("list")
    .description("List installed extensions")
    .action(() =>
      runExtensionAction(async () => {
        const client = createExtensionAdminClient();
        const { extensions } = unwrapAdminResponse(
          await listAdminInstalledExtensions({ client, timeoutMs: EXTENSION_READ_TIMEOUT_MS }),
        );
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
              update: e.hasUpdate ? `→ ${e.latestVersion ?? "Version unknown"}` : "—",
            })),
          ),
        );
      }),
    );

  ext
    .command("preview <idOrUrl>")
    .description(
      "Inspect the current extension snapshot, effective ports and confirmation fingerprint",
    )
    .action((idOrUrl: string) =>
      runExtensionAction(async () => {
        const client = createExtensionAdminClient();
        printExtensionPreview(
          unwrapAdminResponse(
            await previewAdminExtensionInstall(selector(idOrUrl), {
              client,
              timeoutMs: EXTENSION_RESOLUTION_TIMEOUT_MS,
            }),
          ),
        );
      }),
    );

  ext
    .command("install <idOrUrl>")
    .description("Preview then queue an extension install by catalog id or extension.json URL")
    .option(
      "--host-port-confirmation <fingerprint>",
      "Authorize the exact previously inspected host-port snapshot",
    )
    .action((idOrUrl: string, opts: { hostPortConfirmation?: string }) =>
      runExtensionAction(async () => {
        const client = createExtensionAdminClient();
        const options = { client, timeoutMs: EXTENSION_RESOLUTION_TIMEOUT_MS };
        const target = selector(idOrUrl);
        const preview = unwrapAdminResponse(await previewAdminExtensionInstall(target, options));
        requireHostPortReview(preview, opts.hostPortConfirmation);
        const { jobId } = unwrapAdminResponse(
          await installAdminExtension(
            {
              ...target,
              ...(opts.hostPortConfirmation === undefined
                ? {}
                : { hostPortConfirmation: opts.hostPortConfirmation }),
            },
            options,
          ),
        );
        log.ok(`Install queued (job ${jobId}). Track it under Admin → Activity.`);
      }),
    );

  ext
    .command("update <id>")
    .description(
      "Preview then queue an installed extension update to the catalog's current version",
    )
    .option(
      "--host-port-confirmation <fingerprint>",
      "Authorize the exact previously inspected host-port snapshot",
    )
    .action((id: string, opts: { hostPortConfirmation?: string }) =>
      runExtensionAction(async () => {
        const client = createExtensionAdminClient();
        const options = { client, timeoutMs: EXTENSION_RESOLUTION_TIMEOUT_MS };
        const preview = unwrapAdminResponse(await previewAdminExtensionInstall({ id }, options));
        requireHostPortReview(preview, opts.hostPortConfirmation);
        const { jobId } = unwrapAdminResponse(
          await updateAdminExtension(
            id,
            opts.hostPortConfirmation === undefined
              ? undefined
              : { hostPortConfirmation: opts.hostPortConfirmation },
            options,
          ),
        );
        log.ok(`Update queued (job ${jobId}).`);
      }),
    );

  ext
    .command("remove <id>")
    .description("Uninstall an extension (removes its services and integrations)")
    .action((id: string) =>
      runExtensionAction(async () => {
        const client = createExtensionAdminClient();
        const { jobId } = unwrapAdminResponse(
          await removeAdminExtension(id, undefined, {
            client,
            timeoutMs: EXTENSION_RESOLUTION_TIMEOUT_MS,
          }),
        );
        log.ok(`Remove queued (job ${jobId}).`);
      }),
    );
}
