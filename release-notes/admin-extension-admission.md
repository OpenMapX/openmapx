---
impacts: [breaking, security, operator-action]
---

## What changes

Extension preview, install, update and worker execution block every critical
extension until its advisory is cleared. Advisory `maxVersion` is display data,
not a version-based exception. A queued job is checked again before installation
effects. Removal remains available.

Direct manifest URLs resolve using the validated manifest identity at community
trust. Catalog identity, version and digest checks remain enforced. Preview has
an independent one-request/30-second bucket; install and update share their own
bucket at the same limit. Unknown dependency failures use bounded public messages
and safe diagnostics.

Administration requests now reject unknown keys, wrong types, explicit JSON null
and empty effective install selectors. Optional update/remove/refresh bodies may
be absent; remove/refresh accept only an empty object when supplied. ID keeps
precedence over a second manifest URL selector.

## Who is affected

Deployment administrators and custom clients of the extension administration API,
including operators attempting an update of a critically flagged extension.

## Required action

Update custom clients to send canonical request fields. Wait for a critical
advisory to be cleared before attempting another deliberate install or update;
remove the extension if appropriate. Treat HTTP 202 as queued acceptance and
check Activity for completion. Respect 429 `Retry-After`; do not automatically
retry mutations.

The internal operator CLI now previews before install/update. Run
`pnpm openmapx ext preview <idOrUrl>` to inspect the full commit, effective
host/container ports, bind addresses/protocols, source trust and security rating
(including deployment variables and factors). Preview may fetch and stage
repositories. For host ports, deliberately supply the inspected fingerprint with
`ext install <idOrUrl> --host-port-confirmation <fingerprint>` or
`ext update <id> --host-port-confirmation <fingerprint>` after previewing that same
catalog ID. Without host ports the fresh preview may proceed directly. Because
install/update obtain another preview, respect the one-preview-per-30-seconds
limit after `ext preview`; a 429 exits without retrying. Wait for `Retry-After`
before a deliberate new invocation.

Missing or mismatched confirmation exits nonzero before the write. A moving
snapshot requires a new explicit preview and deliberate review. There is no
`--yes` bypass, automatic fingerprint consent, mutation retry or job watcher;
the worker still enforces the inspected snapshot. Direct URLs remain community
content. Reads have 30-second deadlines and preview/writes 180 seconds, including
response bodies. Timeout leaves an uncertain result and does not cancel host
work: check Activity before deliberately retrying. Invalid responses and failures
produce safe stderr and a nonzero exit. No data migration or cache version change
is required.
