import { createHash, randomUUID } from "node:crypto";
import { canonicalJson, protectedConfigurationServiceIdSchema } from "@openmapx/core/ops";
import type { FeedCredentialChange } from "@openmapx/transitous-core/feed-credentials";
import {
  type CredentialImportChoices,
  type CredentialImportPreview,
  credentialImportChoicesSchema,
} from "../../../../../packages/core/src/api/contracts/integration-admin/credential-transfer";
import { withAdministrativeConfigurationRead } from "../administrative-configuration-writer-owner";
import {
  integrationOwnershipSnapshot,
  serviceOwnershipSnapshot,
} from "../configuration-ownership-view";
import type { ProspectiveConfigurationOverlay } from "../prospective-configuration";
import { decrypt } from "../secrets";
import type { FeedCredentialChangePreview } from "../transit-credential-preview";
import { previewFeedCredentialChanges } from "../transit-feed-credential-participant";
import {
  type CredentialTransferPayload,
  decodeTransferredFeedCredentialMap,
  decryptCredentialTransfer,
  encryptCredentialTransfer,
} from "./credential-transfer";
import { migrationSources } from "./sources";
import {
  MigrationConflict,
  type MigrationStage,
  readMigrationStage,
  replaceMigrationStage,
  retainMigrationStage,
} from "./staging";

export type CredentialPlan = {
  payload: CredentialTransferPayload;
  choices?: CredentialImportChoices;
  expectedCurrentRevisionId: string | null;
  sourceRevision: string;
  sourceSnapshot: import("@openmapx/core/ops").ConfigurationSourcesInspection;
  guard: string;
  overlay: ProspectiveConfigurationOverlay;
  entries: CredentialImportPreview["entries"];
  feedPreview?: FeedCredentialChangePreview;
  feedChanges?: FeedCredentialChange[];
  feedOperationKey?: string;
  platformPreview?: import("@openmapx/core/api-contracts").AdminPlatformPreview;
  additionalServiceIds?: string[];
  pendingServiceIds?: string[];
};
const identity = (field: { scope: string; id: string; key: string }) =>
  `${field.scope}:${field.id}:${field.key}`;
export async function exportCredentialSelection(input: {
  actorId: string;
  selection: Array<{ scope: "integration" | "service"; id: string; key: string }>;
  passphrase: string;
}) {
  const source = await migrationSources();
  const payload = await withAdministrativeConfigurationRead({}, async (read) => {
    const entries: CredentialTransferPayload["entries"] = [],
      seen = new Set<string>();
    for (const field of input.selection) {
      if (seen.has(identity(field))) throw new MigrationConflict();
      seen.add(identity(field));
      const snapshot =
          field.scope === "integration"
            ? await integrationOwnershipSnapshot(field.id, read)
            : await serviceOwnershipSnapshot(field.id, read, source),
        ownership = snapshot.ownership[field.key];
      if (
        !ownership?.secret ||
        ownership.source !== "vault" ||
        ownership.managedBy === "dawarich-provisioning"
      )
        throw new MigrationConflict();
      const row =
        field.scope === "integration"
          ? read.integrationSecretRows.find(
              (r) => r.integrationId === field.id && r.key === field.key,
            )
          : read.serviceSecretRows.find((r) => r.serviceId === field.id && r.key === field.key);
      if (!row) throw new MigrationConflict();
      entries.push({ ...field, value: decrypt(row.ciphertext, row.iv, row.tag) });
    }
    return { version: 1 as const, entries };
  });
  return encryptCredentialTransfer(input.actorId, payload, input.passphrase);
}
export async function prepareCredentialPlan(
  payload: CredentialTransferPayload,
  choices: CredentialImportChoices | undefined,
  actorId: string,
): Promise<CredentialPlan> {
  if (choices) choices = credentialImportChoicesSchema.parse(choices);
  const source = await migrationSources(),
    selected = new Map<string, "import" | "skip">();
  for (const choice of choices?.entries ?? []) {
    const id = identity(choice);
    if (selected.has(id) || !payload.entries.some((e) => identity(e) === id))
      throw new MigrationConflict();
    selected.set(id, choice.action);
  }
  return withAdministrativeConfigurationRead({}, async (read) => {
    const changes: ProspectiveConfigurationOverlay["changes"] = [],
      entries: CredentialImportPreview["entries"] = [],
      observations: unknown[] = [];
    let managed: CredentialTransferPayload["entries"][number] | undefined;
    for (const field of payload.entries) {
      const { value: _value, ...publicField } = field,
        action = selected.get(identity(field));
      let denied = false;
      try {
        const snapshot =
            field.scope === "integration"
              ? await integrationOwnershipSnapshot(field.id, read)
              : await serviceOwnershipSnapshot(field.id, read, source),
          owner = snapshot.ownership[field.key];
        observations.push({ field: publicField, ownership: snapshot.ownership });
        denied =
          !owner?.secret ||
          ["env", "config.json"].includes(owner.source) ||
          owner.managedBy === "dawarich-provisioning" ||
          (!owner.writable && owner.managedBy !== "transit.credentials");
      } catch {
        denied = true;
      }
      entries.push({
        ...publicField,
        status:
          action === "skip"
            ? "skipped"
            : denied
              ? "denied"
              : action === "import"
                ? "selected"
                : "skipped",
        ...(denied ? { reason: "undeclared_or_host_owned" } : {}),
      });
      if (denied || action !== "import") continue;
      if (
        field.scope === "service" &&
        field.id === "data-manager" &&
        field.key === "TRANSITOUS_API_KEYS"
      ) {
        managed = field;
        continue;
      }
      changes.push(
        field.scope === "integration"
          ? {
              kind: "integration-secret",
              integrationId: field.id,
              key: field.key,
              action: "set",
              value: field.value,
            }
          : {
              kind: "service-secret",
              serviceId: field.id,
              key: field.key,
              action: "set",
              value: field.value,
            },
      );
    }
    if (choices?.feedMap && !managed) throw new MigrationConflict();
    let feedOperationKey: string | undefined;
    let feedPreview: FeedCredentialChangePreview | undefined,
      feedChanges: FeedCredentialChange[] | undefined;
    if (managed && choices?.feedMap) {
      const map = decodeTransferredFeedCredentialMap(managed.value),
        feed = choices.feedMap,
        seen = new Set<string>();
      feedChanges = [];
      if (feed.setKeys.length + feed.deleteKeys.length > 1000) throw new MigrationConflict();
      for (const key of feed.setKeys) {
        if (seen.has(key) || !Object.hasOwn(map, key)) throw new MigrationConflict();
        seen.add(key);
        feedChanges.push({ key, action: "set", value: map[key]! });
      }
      for (const key of feed.deleteKeys) {
        if (seen.has(key)) throw new MigrationConflict();
        seen.add(key);
        feedChanges.push({ key, action: "delete" });
      }
      feedOperationKey = randomUUID();
      feedPreview = await previewFeedCredentialChanges({
        actorId,
        transfer: true,
        ...feed,
        changes: feedChanges,
        operationKey: feedOperationKey,
        expectedCurrentRevisionId: source.revisionId,
      });
    } else if (managed) {
      const entry = entries.find((e) => identity(e) === identity(managed!));
      if (entry) {
        entry.status = "denied";
        entry.reason = "explicit_feed_map_choices_required";
      }
    }
    if (changes.length + (feedChanges?.length ? 1 : 0) > 512)
      for (const entry of entries)
        if (entry.status === "selected") {
          entry.status = "denied";
          entry.reason = "candidate_limit_512_changes";
        }
    const additionalServiceIds = [
      ...new Set([
        ...changes.flatMap((c) =>
          "serviceId" in c &&
          typeof c.serviceId === "string" &&
          read.services.some((s) => s.manifest.id === c.serviceId && s.enabled)
            ? [c.serviceId]
            : [],
        ),
        ...(feedChanges?.length &&
        read.services.some((s) => s.manifest.id === "data-manager" && s.enabled)
          ? ["data-manager"]
          : []),
      ]),
    ].sort();
    const platformPreview = additionalServiceIds.some(
      (id) => protectedConfigurationServiceIdSchema.safeParse(id).success,
    )
      ? await (await import("./platform-preview")).previewProtectedCredentialMigration({
          actorId,
          read,
          source,
          serviceIds: additionalServiceIds,
        })
      : undefined;
    if (platformPreview) {
      const { version: _version, ...patch } = platformPreview.configuration;
      changes.push({ kind: "platform", patch });
    }
    const guard = createHash("sha256")
      .update(
        canonicalJson({
          sourceOwnership: source.services,
          platformOwnership: source.platform ?? null,
          services: read.serviceRows,
          integrations: read.integrationRows,
          serviceSecrets: read.serviceSecretRows,
          integrationSecrets: read.integrationSecretRows,
          observations,
        }),
      )
      .digest("hex");
    return {
      payload,
      ...(choices ? { choices } : {}),
      expectedCurrentRevisionId: source.revisionId,
      sourceRevision: source.sourceRevision,
      sourceSnapshot: source,
      ...(platformPreview ? { platformPreview, additionalServiceIds } : {}),
      pendingServiceIds: [
        ...new Set(
          changes.flatMap((c) =>
            "serviceId" in c &&
            typeof c.serviceId === "string" &&
            read.services.some((s) => s.manifest.id === c.serviceId && !s.enabled)
              ? [c.serviceId]
              : [],
          ),
        ),
      ],
      guard,
      overlay: { purpose: "migration", coordinatorMode: "ensure-running", changes },
      entries,
      ...(feedPreview ? { feedPreview, feedChanges, feedOperationKey } : {}),
    };
  });
}
export function credentialPlanPreview(
  stage: MigrationStage,
  plan: CredentialPlan,
): CredentialImportPreview {
  return {
    previewId: stage.previewId,
    intentFingerprint: stage.fingerprint,
    expectedCurrentRevisionId: plan.expectedCurrentRevisionId,
    expiresAt: stage.expiresAt,
    entries: plan.entries,
    ...(plan.feedPreview
      ? { feedMap: { ...plan.feedPreview, intentFingerprint: stage.fingerprint } }
      : {}),
    applyable:
      !!plan.choices &&
      !plan.entries.some((e) => e.status === "denied") &&
      (plan.overlay.changes.length > 0 || !!plan.feedChanges?.length),
  };
}
export async function previewCredentialTransfer(input: {
  actorId: string;
  envelope: unknown;
  passphrase: string;
  choices?: CredentialImportChoices;
}) {
  const payload = await decryptCredentialTransfer(input.actorId, input.envelope, input.passphrase),
    plan = await prepareCredentialPlan(payload, input.choices, input.actorId),
    stage = await retainMigrationStage({
      actorId: input.actorId,
      kind: "credentials",
      value: plan,
    });
  return credentialPlanPreview(stage, plan);
}
export async function chooseCredentialTransferFields(input: {
  actorId: string;
  previewId: string;
  fingerprint: string;
  choices: CredentialImportChoices;
}) {
  const stage = await readMigrationStage({ ...input, kind: "credentials" }),
    old = stage.value as CredentialPlan,
    plan = await prepareCredentialPlan(old.payload, input.choices, input.actorId),
    next = await replaceMigrationStage({ ...input, kind: "credentials", value: plan });
  return credentialPlanPreview(next, plan);
}
