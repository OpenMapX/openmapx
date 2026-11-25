/**
 * The schemas a data export carries, by the id its manifest names in
 * `members[].schema`. An id is `<schema-name>-<version>`; the schema's `$id`
 * is `urn:openmapx:privacy:<schema-name>:<version>`. A member without a schema
 * names none.
 */
export const ARCHIVE_SCHEMA_IDS = {
  exportManifest: "export-manifest-1",
  exportRecord: "export-record-1",
  portableProfile: "portable-profile-1",
  portablePlaces: "portable-places-1",
  processingInformation: "processing-information-1",
} as const;
export type ArchiveSchemaId = (typeof ARCHIVE_SCHEMA_IDS)[keyof typeof ARCHIVE_SCHEMA_IDS];

/** The `$id` of the schema an archive schema id names. */
export function archiveSchemaUrn(schemaId: ArchiveSchemaId): string {
  const match = /^(.+)-(\d+)$/.exec(schemaId);
  if (!match) throw new Error(`Invalid archive schema id: ${schemaId}`);
  return `urn:openmapx:privacy:${match[1]}:${match[2]}`;
}

/** The schema a portable member follows, or none. */
export function portableSchemaId(target: string): ArchiveSchemaId | undefined {
  if (target === "profile") return ARCHIVE_SCHEMA_IDS.portableProfile;
  if (target === "portable-places") return ARCHIVE_SCHEMA_IDS.portablePlaces;
  return undefined;
}
