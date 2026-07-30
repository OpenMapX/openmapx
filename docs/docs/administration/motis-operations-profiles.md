# MOTIS operations profiles

OpenMapX runs MOTIS regionally by default. The selected profile is an explicit safety and sovereignty contract; an empty country list never means “planet”.

## Profiles

| Profile | Acquisition | Hosted runtime fallback | Required scope | Status |
|---|---|---|---|---|
| `regional-assisted` | Pinned Transitous artifacts or origin build | Allowed | Countries or feed allow-list | Supported default |
| `regional-sovereign` | Pinned catalog plus origin downloads | Prohibited | Countries/feed allow-list and local OSM | Supported with network isolation |
| `planet` | Pinned build inputs and allow-listed GBFS batches | Prohibited by default | `MOTIS_PLANET_CONFIRM=true` plus operator capacity | Experimental |

Configure at minimum:

```dotenv
MOTIS_OPERATIONS_PROFILE=regional-assisted
TRANSITOUS_COUNTRIES=de,at,ch
MOTIS_OSM_REGION=europe/germany
MOTIS_SLOT_MEMORY=16g
MOTIS_SLOT_MEMORY_GB=16
MOTIS_SLOT_CPU=4
MOTIS_TWO_SLOT=true
```

MOTIS is the only runtime that compiles and serves static schedules. Postgres
holds operational source, job, validation, and promotion metadata only; no GTFS
schedule tables are populated.

Sovereign mode also requires `TRANSIT_SOURCE=build` and disables the Transitous runtime provider. Do not set a Transitous artifact URL. Preflight rejects sources without an origin URL or declared license. The build writes a redacted `sovereign-source-manifest.json` before acquisition, then records the local archive hash, size, retrieval time, and declared transformations after acquisition; it is included in the candidate integrity manifest.

Route origin downloads through the local feed proxy and enforce the deployment egress allow-list outside the application process. OpenMapX additionally rejects known Transitous/Triptix runtime URLs in generated sovereign configs, but that application check is not a substitute for a host/firewall egress policy.

## Dry-run and capacity gate

The pipeline runs `preflight` after catalog filtering and before any feed/GBFS download. It conservatively estimates compressed feeds, expanded GTFS, MOTIS indexes, OSM, proxy cache, the active dataset, a full candidate, retained rollback generations, and 20% headroom. It blocks on disk, inode, memory, CPU, file-descriptor, scope, feed-count, sovereign OSM, or sovereign-host violations.

`POST /transit/preflight` returns the same result without downloading. The admin data workflow shows the last estimate and measured free disk. Size estimates remain labeled `conservative-defaults` until historical files exist.

Planet mode additionally requires operator-provided capacity at or above the experimental floor (64 GB RAM, 8 CPUs, 500 GB free disk). These are admission floors, not performance promises.

## Two-slot activation and recovery

Set `MOTIS_TWO_SLOT=true` to use `data/motis/slots/A|B`. The inactive slot can
import for as long as needed. Promotion stops both MOTIS processes, selects the
candidate slot, force-recreates the query-facing service so Docker resolves its
bind mount, and runs the same capability probes through the stable URL. Only
then are slot state and feed-proxy state committed.

Requested source state and active source state are deliberately separate. An
add, disable, re-enable, or sync request starts an asynchronous job and changes
the requested set; the active set changes only after acquisition, validation,
candidate import, and post-activation probes succeed. Failure leaves the prior
live slot and active source set untouched. Catalog sources can be disabled and
re-enabled. Operator sources must declare region, safe name, URL, attribution,
and either an SPDX identifier or license URL.

On a failed restart, post-activation probe, or proxy commit, selection returns to
the previously recorded healthy slot without reimport. On manager restart, the
recorded post-probe state wins over an uncommitted candidate selection. A backup
before an update is optional because the previous healthy slot is retained for
rollback. When policy requires a separate backup, include `slot-state.json`,
candidate manifests, capability snapshots, configs, attribution/license files,
locks, and any approved sidecar database—never treat an unprobed directory copy
as restored.

Recovery drill:

1. Restore manifests/config/data into the inactive slot.
2. Start only the staging service and run functional capability probes.
3. Record expected epoch and manifest hashes.
4. Flip in a disposable environment, probe through the stable URL, then force rollback.
5. Declare the backup usable only when both activation and rollback meet the recorded SLO.

## Pin upgrades

`openmapx transitous bump` and `POST /transit/bump` write `*.proposed.json`; they do not mutate active pins. Review catalog/feed/license diffs, build the inactive slot, and run the timetable, rental, planner, attribution, and response-contract canaries. API activation requires typing the exact proposed ref at `/transit/bump/approve`. Keep previous pins with the previous healthy slot.

Mutable tags such as `latest` are prohibited. MOTIS currently uses the repository-wide pinned release.

## Static-query semantics and optional shapes

Stop timetables use the stop's local civil day, not a UTC day. Route-pattern IDs
returned by the MOTIS adapter are bound to the active dataset epoch and are not
durable external identifiers; clients must reacquire them after promotion. Route
detail and pattern geometry currently use the experimental MOTIS
`/api/experimental/map/route-details` endpoint from the repository-pinned MOTIS
release. Treat a pin change as an API-contract change and run the full canary
before activation.

`MOTIS_ROUTE_SHAPES=missing` optionally asks MOTIS to compute geometry for routes
whose feeds omit shapes. It is off by default because it increases import time,
index size, and RAM use. Measure it in the inactive slot before enabling it for
a production scope; `all` costs more and should be treated as a deliberate
capacity change.

## Planet acceptance gate

Planet stays experimental until a dated benchmark records host specs, pinned inputs, download volume, import wall time, peak RSS/CPU, temporary/final disk, provider counts, first-query latency, probe time, and rollback time for small-region, large-country, and multi-continent fixtures. Production-ready status requires two consecutive full builds and one forced rollback meeting declared dataset-age, build-duration, query-p95, failure-tolerance, rollback, and disk-headroom SLOs.

## Crowdsource decision

Crowdsource sidecars are intentionally absent. The audited Transitous deployment referenced opaque/mutable binaries without an authoritative pinned source/release chain, and the protocol/governance evidence did not establish a license, controller, authentication, abuse/moderation, retention/deletion, consent, or takedown contract. This is a hard rejection for packaging—not a feature flag waiting to be switched on.

Do not accept crowdsource submissions until a new review supplies all missing evidence and security, legal/privacy, and maintainer owners approve it. A future prototype must be isolated, non-root, read-only except for its own database/outbox, egress-allow-listed, rate-limited, consented, moderated, and deletion-tested.
