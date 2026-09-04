# Privacy backup collector

This image restores only descriptor-verified format-v2 PostgreSQL backup inputs
inside its networkless container and emits a fixed, streamed subject tar. Build
locally with:

```sh
docker build -f services/ops-agent/privacy-backup/Dockerfile -t openmapx/privacy-backup:local .
docker image inspect openmapx/privacy-backup:local --format '{{.Id}}'
```

Release automation must publish the reviewed image, record its registry
`sha256` digest, and configure
`OPS_PRIVACY_BACKUP_COLLECTOR_IMAGE=ghcr.io/openmapx/privacy-backup@sha256:<digest>`.
Never substitute a tag or document a digest before publication.

Run the real networkless restore fixture with:

```sh
node services/ops-agent/privacy-backup/test-fixture.mjs
```
