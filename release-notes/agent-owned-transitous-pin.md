---
impacts: [security, operator-action]
---

## What changes

The operations agent keeps the Transitous catalog pin it approves, and the pin
proposed for an inactive slot, in its own state directory,
`infra/docker/state/ops-agent/transitous/`, which only the deployment's user can
reach. It no longer rewrites the tracked `infra/docker/transitous.lock.json`,
and reads neither that file nor `infra/docker/transitous.lock.proposed.json`
from the host checkout: the release's pin comes from the copy its image
carries. `pnpm openmapx transitous bump` writes its proposal into the same
state, and `transitous show` prints the release's pin, the pin in effect, an
approved pin and a proposal.

An approved pin holds until a release ships a different one. That release's
pin then takes over: the agent removes the approval at startup, logs which pin
it retired, and the auto-bump, if enabled, proposes again through its canary.

## Who is affected

Every Docker deployment. Deployments where an earlier agent approved a pin
have that approval in the tracked lock file.

## Required action

Only if `git status` shows `infra/docker/transitous.lock.json` modified, restore
it before pulling, so `git pull --ff-only` is not stopped by it:

```bash
git checkout -- infra/docker/transitous.lock.json
```

The approval it held is not carried over: the new release's pin applies until a
new approval. A leftover `infra/docker/transitous.lock.proposed.json` is no
longer read and can be deleted.
