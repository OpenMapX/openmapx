# Preserve coordinator ownership during release selection

## Intent and evidence

Deploy the merged admin UX through the existing guarded full-release updater.
The user authorizes fixes, independent merges after review, and production deployment.
The host is healthy on 41f64e32. Main 61b5b82 and its published release are qualified.
The old seven-image selection has been restored and all five container identities
and images, both Valhalla hashes, and global Node match the pre-deployment receipt.

Two source defects blocked the documented CLI procedure: `services update` rejects
Data Manager, while the preceding `compose release` replaces its expected pin and
makes its running container unverified. The guarded updater deliberately requires
a real administrator; this repair does not invent an administrator identity.

## Approaches

1. Remove the CLI coordinator guard or use Start/Compose Up to replace it: rejected;
   this skips the original nominal drain, maintenance, and recovery protocol.
2. Add a new non-human full-release producer: possible, but it requires a new
   authorization/SQL participant and a bootstrap protocol. That is a separate
   subsystem, not necessary to use the already implemented full-release updater.
3. Reuse the existing real-admin platform/release producer through a CLI client,
   rather than adding another lifecycle or principal. Add a checked-candidate
   command that caches the validated release without changing selected pins,
   then an authenticated CLI update that backs up and calls the existing public
   preview/apply endpoints. Selected by the implementer within the user's
   explicit instruction to do the necessary work autonomously.

## Additional confirmed bootstrap defect

`system.inspect` returns `release.selectedReleaseId`, but its strict result
schema omits that field. The pure parser rejects a minimal matching response;
production's `/api/admin/system` consequently reports maintenance unavailable.
Add the already-supported release-inspection field to that nested schema and
test the actual production runtime response through the parser. Do not relax
strictness for arbitrary fields.

The CLI bridge must also work against this older API: use the existing public
platform preview/apply endpoints, which perform their own nominal checks and
do not depend on the broken system-status observation. A release-only request
contains unchanged platform configuration and an exact checked release. This
is the same producer used by the full application updater, not a direct Docker
replacement. All existing administrator, source, job, SQL, maintenance and
handoff checks remain in place.

## Checked release and authenticated CLI bridge

`compose release --check` resolves and validates metadata, stores canonical
immutable manifest bytes and the existing checked-selection receipt/latest
pointer under the release-store lock, and prints the release ID and canonical
manifest digest. It never changes the overlay, current/running state or any
container. Share the cache publisher with the ops-agent's existing resolve
implementation; retain the 64-entry / 32-KiB manifest limits and configuration
identity checks. Existing immutable bytes must match exactly. Reject active
transactions, changed configured selection and unsafe files.

`system update --release <id> --digest <canonical-digest> --session-file <path>`
uses an authentic administrator cookie from a private owner-only file and the
existing API, with a valid configured Origin and no redirects. Default to the
loopback API; allow HTTPS or loopback HTTP, never arbitrary cleartext credential
transport. Do not log or persist the cookie. The API continues to authorize the
real actor; no user account or session is manufactured.

Persist an owner-only operation receipt before each POST, including the real
actor ID, exact target, stable idempotency keys, frozen request bodies and returned
job IDs. Resume the same receipt after interrupted transport; never mint another
request to replace an unknown outcome. Credentials are re-read separately and
must identify the original actor. Create a named backup through the existing
idempotent backup endpoint and wait for its original job to succeed. Acquire a
fresh platform snapshot and preview with `changes: {version: 1}` plus the checked
release. Verify unchanged configuration, effective values/sources and origin,
the exact release, the finite five-service release target and no domain recovery
confirmations. Save that exact preview/apply body, submit once with its retained
key, and observe the original application job to a complete committed outcome.
An expired/conflicting preview fails with guidance; it is not silently replaced.
Failed or unknown jobs never mean success. Bound each HTTP read and polling wait;
an observation timeout leaves the receipt resumable rather than resubmitting.

## Contract

Before publishing a release selection, inspect the actual Docker project's Data
Manager containers through the existing external Docker runner. Zero containers
permits bootstrap. Exactly one container permits selection only when the candidate
Data Manager image reference equals its Config.Image and its actual image ID is
the image ID resolved from that immutable reference. Running and stopped containers
are both covered. Ambiguous, malformed, missing-image and failed observations
refuse selection. Never infer absence from a failed Docker command.

Hold the existing release-store lock across inspection and publication. Do not
change lock ordering, acquire nested configuration writers, or remove locks.
Automatic selection accepts the actual held ReleaseStoreLock from lifecycle
ownership, or acquires it itself after migration; re-read the overlay under it.
Busy, unsafe observation and guard refusal return `held`, not a registry error.
Both explicit and automatic selection refuse a retained transaction.json.
Automatic selection when no overlay exists must use the same guard; preserving an
existing overlay remains read-only. A refused selection preserves the overlay and
privacy evidence bytes. Restoring a pin that exactly matches the actual container
remains possible. No lifecycle command is executed by the guard.

Clearing a valid overlay that is still used by one matching Data Manager also
refuses, preserving its bytes. A mismatched/malformed overlay can still be cleared
for recovery; conditional clearing binds the observed release ID when parseable.
Never treat failed or ambiguous container observations as safe absence.

The CLI should name System → Updates (legacy Maintenance at /admin/system) as the
full-release workflow and explain that ordinary host service updates preserve
pins and cannot update Data Manager. Bootstrap remains supported when no
coordinator exists. Do not document positional arguments `compose release` lacks.

## Delivery and verification

One focused PR, assigned Medformatik with existing appropriate labels. Deterministic
CLI tests use real private release files and mock only Docker I/O. Run relevant
CLI/core tests, types, lint, full local verification and docs build; qualify all
current-head CI, merge normally, then qualify main and release publication.

The browser profile currently has no admin session. Obtain a real session through
the private credential tool or the user's normal sign-in, never from database
session extraction, account impersonation, or a manufactured session. Then inspect
the updater's checked exact candidate, apply with backup, and follow its original
job through completion. If a new concrete defect appears, reproduce, review, test
and fix it before trying the deployment again. Verify actual running image digests,
health, public availability and preserved customizations. Selected pins alone do
not establish deployment.
