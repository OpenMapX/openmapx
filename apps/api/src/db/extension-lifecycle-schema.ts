import type { ExtensionConfigTarget } from "@openmapx/core/api-contracts";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { oneOf } from "./closed-value-check";
import { installedExtension } from "./installed-extension-schema";

/**
 * One extension-level `config[]` value: plain, or encrypted when the entry is a
 * secret. No foreign key: removing an extension with its data kept leaves the
 * rows for that extension to re-attach.
 */
export const extensionSetting = pgTable(
  "extension_setting",
  {
    extensionId: text("extension_id").notNull(),
    key: text("key").notNull(),
    value: text("value"),
    ciphertext: text("ciphertext"),
    iv: text("iv"),
    tag: text("tag"),
    keyVersion: integer("key_version"),
    // The entry's targets as declared, so a value can be projected again when
    // an optional service is enabled later.
    targets: jsonb("targets").$type<ExtensionConfigTarget[]>().notNull(),
    generated: boolean("generated").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    primaryKey({ name: "extension_setting_pkey", columns: [table.extensionId, table.key] }),
    check(
      "extension_setting_key_check",
      sql`${table.key} ~ '^[a-z][a-z0-9]*([A-Z][a-z0-9]+)*$' and char_length(${table.key}) <= 64`,
    ),
    check(
      "extension_setting_value_check",
      sql`(${table.value} is not null and ${table.ciphertext} is null and ${table.iv} is null and ${table.tag} is null and ${table.keyVersion} is null) or (${table.value} is null and ${table.ciphertext} is not null and ${table.iv} is not null and ${table.tag} is not null and ${table.keyVersion} is not null)`,
    ),
    check("extension_setting_targets_check", sql`jsonb_typeof(${table.targets}) = 'array'`),
    check(
      "extension_setting_generated_check",
      sql`not ${table.generated} or ${table.ciphertext} is not null`,
    ),
  ],
);

export const EXTENSION_NAME_CLAIM_KINDS = [
  "service",
  "integration",
  "database-role",
  "database-schema",
] as const;

/** A name bound to the extension that first installed it and to its source. */
export const extensionNameClaim = pgTable(
  "extension_name_claim",
  {
    kind: text("kind").$type<(typeof EXTENSION_NAME_CLAIM_KINDS)[number]>().notNull(),
    name: text("name").notNull(),
    extensionId: text("extension_id").notNull(),
    // `verified` for a verified extension, otherwise the source's address.
    source: text("source").notNull(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ name: "extension_name_claim_pkey", columns: [table.kind, table.name] }),
    check("extension_name_claim_kind_check", oneOf(table.kind, EXTENSION_NAME_CLAIM_KINDS)),
    index("extension_name_claim_extension_id_idx").on(table.extensionId),
  ],
);

/** A catalogue source the operator added; the default source is not stored. */
export const extensionCatalogSource = pgTable("extension_catalog_source", {
  url: text("url").primaryKey(),
  label: text("label").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export interface StoredRevocations {
  removed: [id: string, reason: string][];
  critical: [id: string, advisory: { reason: string; maxVersion?: string }][];
}

/** The last revocation feed that parsed; one row, never expired. */
export const extensionRevocationSnapshot = pgTable(
  "extension_revocation_snapshot",
  {
    id: integer("id").primaryKey(),
    snapshot: jsonb("snapshot").$type<StoredRevocations>().notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    check("extension_revocation_snapshot_singleton_check", sql`${table.id} = 1`),
    check(
      "extension_revocation_snapshot_snapshot_check",
      sql`coalesce(jsonb_typeof(${table.snapshot}->'removed') = 'array' and jsonb_typeof(${table.snapshot}->'critical') = 'array', false)`,
    ),
  ],
);

/** A critical advisory an administrator acknowledged by enabling the extension again. */
export const extensionAdvisoryAck = pgTable(
  "extension_advisory_ack",
  {
    extensionId: text("extension_id").notNull(),
    advisoryKey: text("advisory_key").notNull(),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      name: "extension_advisory_ack_pkey",
      columns: [table.extensionId, table.advisoryKey],
    }),
    // An acknowledgement belongs to one installed copy of the extension.
    foreignKey({
      name: "extension_advisory_ack_extension_id_fkey",
      columns: [table.extensionId],
      foreignColumns: [installedExtension.id],
    }).onDelete("cascade"),
    check(
      "extension_advisory_ack_advisory_key_check",
      sql`${table.advisoryKey} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
);

export type ExtensionSettingRow = typeof extensionSetting.$inferSelect;
export type ExtensionNameClaimRow = typeof extensionNameClaim.$inferSelect;
export type ExtensionCatalogSourceRow = typeof extensionCatalogSource.$inferSelect;
export type ExtensionRevocationSnapshotRow = typeof extensionRevocationSnapshot.$inferSelect;
export type ExtensionAdvisoryAckRow = typeof extensionAdvisoryAck.$inferSelect;
