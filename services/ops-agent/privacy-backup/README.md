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

The emitted source archive uses uncompressed USTAR regular files (`ustar\0`,
version `00`), zero member padding, and two zero end blocks. PAX/GNU extensions,
links and other member types are outside this protocol. The API's shared privacy
reader validates framing; the backup and live Dawarich consumers separately
validate allowed paths, subject/cutoff, manifest ordering and content digests.

The complete emitted set, including the final inner and outer manifests, must fit
256 members, 256 MiB per member, 2 GiB total content and 256 KiB per manifest.
The producer validates these budgets before opening the output archive. The reader
also bounds raw framing/trailer bytes and consumes one member at a time into
encrypted storage. Stream memory depends on upstream chunk size; it does not
buffer whole archives.

Portable tests include real Python `tarfile` and Ruby `Gem::Package::TarWriter`
interoperability, so they require `python3` and `ruby` on `PATH`. The exact-image
Dawarich and networkless restore fixtures remain separate integration gates.
