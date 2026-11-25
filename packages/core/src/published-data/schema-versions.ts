/**
 * The layout version of each published search and place snapshot. A builder
 * writes its version into the snapshot's state row; readers serve only a
 * snapshot of the version they were written for, and data-manager rebuilds a
 * snapshot whose version differs. Raise a version whenever a builder changes
 * the tables, columns or meaning of what it publishes.
 */
export const OSM_SEARCH_SCHEMA_VERSION = 1;
export const NOTABLE_PLACES_SCHEMA_VERSION = 1;
export const OVERTURE_PLACES_SCHEMA_VERSION = 1;

/**
 * A SQL condition that holds when the `overture_places` row named `alias` (a
 * table with a `release` column: `places` or `poi_conflation_link`) belongs to
 * the snapshot readers may serve: the state row's release, written with
 * `OVERTURE_PLACES_SCHEMA_VERSION`. The query passes that version as the
 * parameter `$<versionParam>`.
 */
export function currentOvertureSnapshot(alias: string, versionParam: number): string {
  return `EXISTS (SELECT 1 FROM overture_places.conflation_state AS current_snapshot WHERE current_snapshot.singleton = 1 AND current_snapshot.release = ${alias}.release AND current_snapshot.schema_version = $${versionParam})`;
}
