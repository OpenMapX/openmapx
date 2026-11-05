import type { StandaloneFilesystemEntry, StandaloneInventoryEntry } from "@openmapx/core/ops";

interface Input {
  files: StandaloneFilesystemEntry[];
  integrations: Array<{ id: string; installedVersion: string; managedByExtension: string | null }>;
  parents: Array<{
    id: string;
    installationKind: "catalog" | "standalone";
    provenance: { kind: string; contentDigest?: string } | null;
  }>;
  components: Array<{ kind: string; componentId: string; extensionId: string }>;
}
/** Local ownership comes from installed rows and actual bytes, never catalog enrichment. */
export function mergeStandaloneInventory(input: Input): StandaloneInventoryEntry[] {
  const ids = new Set([
    ...input.files.map((x) => x.integrationId),
    ...input.integrations.map((x) => x.id),
    ...input.components.filter((x) => x.kind === "integration").map((x) => x.componentId),
  ]);
  return [...ids].sort().map((integrationId) => {
    const file = input.files.find((x) => x.integrationId === integrationId),
      row = input.integrations.find((x) => x.id === integrationId),
      components = input.components.filter(
        (x) => x.kind === "integration" && x.componentId === integrationId,
      ),
      owner = components[0]?.extensionId ?? row?.managedByExtension ?? null,
      parent = input.parents.find((x) => x.id === owner);
    let ownership: StandaloneInventoryEntry["ownership"] = "unmanaged",
      denialReason = file?.denialReason ?? null;
    if (
      (owner && (!row || components.length !== 1 || row.managedByExtension !== owner)) ||
      components.length > 1 ||
      (row?.managedByExtension && row.managedByExtension !== owner) ||
      (owner && !parent)
    )
      ownership = "conflict";
    else if (parent)
      ownership = parent.installationKind === "standalone" ? "standalone" : "extension";
    if (!file) {
      if (ownership === "standalone" && row && components.length === 1)
        denialReason =
          "Local files are missing. Removal verifies absence before cleaning up ownership records.";
      else {
        ownership = "conflict";
        denialReason =
          "Recorded installation is missing from local storage; reconcile its original Activity job.";
      }
    } else if (!file.valid)
      denialReason ??= "Legacy content cannot be safely managed; inspect it on the host.";
    if (ownership === "conflict")
      denialReason ??=
        "Installation ownership is inconsistent; resolve the original owner before changing it.";
    if (ownership === "extension")
      denialReason ??= "Managed by an extension; use that extension's controls.";
    const usable = !!file?.valid && file.contentDigest !== null;
    return {
      ...(file?.pendingTransactionId ? { pendingTransactionId: file.pendingTransactionId } : {}),
      integrationId,
      version: file?.version ?? row?.installedVersion ?? null,
      ownership,
      extensionId: owner,
      contentDigest: file?.contentDigest ?? null,
      provenance: (["artifact", "source", "uploaded-artifact"].includes(
        parent?.provenance?.kind ?? "",
      )
        ? parent!.provenance!.kind
        : "legacy_unknown") as StandaloneInventoryEntry["provenance"],
      adoptable: usable && ownership === "unmanaged",
      removable:
        (usable && (ownership === "standalone" || ownership === "unmanaged")) ||
        (!file && ownership === "standalone"),
      denialReason,
    };
  });
}
