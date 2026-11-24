---
impacts: [breaking, migration, operator-action]
---

## What changes

Data-manager publishes a rebuilt search index, notable places, Overture
release, OSM POI snapshot or set of conflation links by renaming the new copy
into place and dropping the old one afterwards. API searches no longer wait
for a publication, also while a backup runs. Publications of the search index,
notable places and Overture data instead wait for a running backup, at most a
second per attempt, and fail after about two minutes of retries, leaving the
data set as last published. A backup therefore always holds each data set as
it was last published. A publication that commits in the first moments of a
backup makes that backup fail; a backup that meets an Overture, OSM POI or
link publication can fail with "deadlock detected". Both leave no archive.

Backups leave out what data-manager rebuilds and never serves: unpublished and
replaced copies (the `__staging` and `__previous` schemas and tables), nearby
places' unfinished planet candidates, and the rows of Overture conflation's
workspace and embedding cache. After a restore, an Overture conflation that was
running starts again from OSM extraction, and a planet build of nearby places
that was running cannot be resumed: discard its candidate and publish again.
A regional nearby-places build fails, and keeps the last good generation live,
when a source data set it read was republished during the build.

The API now deletes, once a day, the records whose period the privacy
catalogue declares: sessions, administrator confirmations, OAuth tokens and
client assertions 30 days after they expire, administrative receipts after
one year (the newest receipt for each integration and account stays),
disclosure records after three years, share links and parked locations 30
days after their expiry, and offline-package records that match no existing
account 30 days after they were recorded. A record covered by the retention
hold of an open privacy request stays until the request closes. The catalogue,
the privacy page and the export copy state these periods.

Data-manager's runtime schemas changed: points are indexed `geometry`
columns, H3 cells are `bigint`, nearby places keep every generation in one
partitioned table, the embedding cache lives in its own schema
`overture_embeddings` and survives Overture releases, and runtime indexes are
named after their table. The API's migration baseline gained the indexes the
retention task prunes by.

## Who is affected

Every database and data volume created by an earlier development build. No
released installation exists. Operators who schedule backups or rebuilds.

## Required action

Install fresh with an empty database volume, as for the migration baseline:
there is no upgrade path for the API's migrations or for data-manager's runtime
schemas. Rebuild the data sets after installing. Schedule backups so that they
do not overlap planned rebuilds, and run a publication or backup that failed
because of the other again afterwards. See Backup & restore in the
administration docs.
