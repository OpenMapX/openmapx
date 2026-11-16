---
impacts: [security, operator-action]
---

## What changes

The update system no longer signs its records. Each role keeps its control
records as plain files in its own state directory, which no other service
mounts: the operations agent in `infra/docker/state/ops-agent/control`, Data
Manager in `infra/docker/state/data-manager/control` and the host CLI in
`infra/docker/state/host-cli/control`. Since only their owner writes them, a
signature added nothing; every record is still checked against its schema when
it is read.

`openmapx compose render` no longer creates the three Ed25519 role keys
(`infra/docker/secrets/control-ops-agent.key`, `control-data-manager.key`,
`control-host-cli.key`), the verifier bundle
(`infra/docker/secrets/control-verifiers.json`) or `infra/docker/control-private`.
The operations agent, Data Manager and the configuration helper no longer mount
them, and the agent no longer needs the bind mounts that hid the other roles'
keys from it. The API's link from a child operation to its admin job, and the
artifact-transfer and standalone-integration records, no longer carry a MAC;
the API's request is authenticated by its token as before.

## Who is affected

Installations created before this release that still have the key files or the
`control-private` directory. Fresh installations are not affected.

## Required action

Stop the stack, then delete the old files by hand:

```bash
rm -f infra/docker/secrets/control-ops-agent.key \
  infra/docker/secrets/control-data-manager.key \
  infra/docker/secrets/control-host-cli.key \
  infra/docker/secrets/control-verifiers.json
rm -rf infra/docker/control-private
```

Records under the old directory are not migrated; run `openmapx compose render`
and start the stack again.
