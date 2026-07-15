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

Sovereign mode also requires `TRANSIT_SOURCE=build` and disables the Transitous runtime provider. Do not set a Transitous artifact URL. Preflight rejects sources without an origin URL or declared license. The build writes a redacted `sovereign-source-manifest.json` before acquisition, then records the local archive hash, size, retrieval time, and declared transformations after acquisition; it is included in the candidate integrity manifest.

Route origin downloads through the local feed proxy and enforce the deployment egress allow-list outside the application process. OpenMapX additionally rejects known Transitous/Triptix runtime URLs in generated sovereign configs, but that application check is not a substitute for a host/firewall egress policy.

## Dry-run and capacity gate

The pipeline runs `preflight` after catalog filtering and before any feed/GBFS download. It conservatively estimates compressed feeds, expanded GTFS, MOTIS indexes, OSM, proxy cache, the active dataset, a full candidate, retained rollback generations, and 20% headroom. It blocks on disk, inode, memory, CPU, file-descriptor, scope, feed-count, sovereign OSM, or sovereign-host violations.

`POST /transit/preflight` returns the same result without downloading. The admin data workflow shows the last estimate and measured free disk. Size estimates remain labeled `conservative-defaults` until historical files exist.

Planet mode additionally requires operator-provided capacity at or above the experimental floor (64 GB RAM, 8 CPUs, 500 GB free disk). These are admission floors, not performance promises.

## Two-slot activation and recovery

Set `MOTIS_TWO_SLOT=true` to migrate `data/motis/live` and `data/motis/staging` to `data/motis/slots/A|B`. Compatibility symlinks keep existing service manifests working. The inactive slot imports for as long as needed; promotion stops both MOTIS processes, flips the aliases, force-recreates the query-facing service so Docker re-resolves its bind mount, and runs the same capability probes through the stable URL. Only then are slot state and feed-proxy state committed.

On a failed restart, post-activation probe, or proxy commit, aliases flip back to the previously recorded healthy slot without reimport. On manager restart, recorded post-probe state wins over an uncommitted alias flip. Back up `slot-state.json`, candidate manifests, capability snapshots, configs, attribution/license files, locks, and any approved sidecar database—never treat an unprobed directory copy as restored.

Recovery drill:

1. Restore manifests/config/data into the inactive slot.
2. Start only the staging service and run functional capability probes.
3. Record expected epoch and manifest hashes.
4. Flip in a disposable environment, probe through the stable URL, then force rollback.
5. Declare the backup usable only when both activation and rollback meet the recorded SLO.

## Pin upgrades

`openmapx transitous bump` and `POST /transit/bump` write `*.proposed.json`; they do not mutate active pins. Review catalog/feed/license diffs, build the inactive slot, and run the timetable, rental, planner, attribution, and response-contract canaries. API activation requires typing the exact proposed ref at `/transit/bump/approve`. Keep previous pins with the previous healthy slot.

Mutable tags such as `latest` are prohibited. MOTIS currently uses the repository-wide pinned release.

## Planet acceptance gate

Planet stays experimental until a dated benchmark records host specs, pinned inputs, download volume, import wall time, peak RSS/CPU, temporary/final disk, provider counts, first-query latency, probe time, and rollback time for small-region, large-country, and multi-continent fixtures. Production-ready status requires two consecutive full builds and one forced rollback meeting declared dataset-age, build-duration, query-p95, failure-tolerance, rollback, and disk-headroom SLOs.

## Crowdsource decision

Crowdsource sidecars are intentionally absent. The audited Transitous deployment referenced opaque/mutable binaries without an authoritative pinned source/release chain, and the protocol/governance evidence did not establish a license, controller, authentication, abuse/moderation, retention/deletion, consent, or takedown contract. This is a hard rejection for packaging—not a feature flag waiting to be switched on.

Do not accept crowdsource submissions until a new review supplies all missing evidence and security, legal/privacy, and maintainer owners approve it. A future prototype must be isolated, non-root, read-only except for its own database/outbox, egress-allow-listed, rate-limited, consented, moderated, and deletion-tested.
