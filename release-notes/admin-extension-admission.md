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

Explicit operator CLI preview and host-port fingerprint confirmation are planned
in the subsequent administration SDK caller task. They are not implemented by
this admission change. Host ports still require deliberate authorization bound
to the exact inspected snapshot. No data migration or cache version change is
required.
