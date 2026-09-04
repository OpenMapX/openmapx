# syntax=docker/dockerfile:1.7

# Keep the restore engine aligned with the deployment's reviewed PostgreSQL/PostGIS image.
FROM ghcr.io/baosystems/postgis:18-3.6@sha256:7de6306fe0718b72eebea405f2ff2ed9a3581a002ee1251978eba7b5e51c16b6

RUN apt-get update && apt-get install -y --no-install-recommends python3 ca-certificates && \
    rm -rf /var/lib/apt/lists/*
COPY services/ops-agent/privacy-backup/openmapx-backup-subject-export.py /usr/local/bin/openmapx-backup-subject-export
RUN chmod 0555 /usr/local/bin/openmapx-backup-subject-export

USER postgres
ENTRYPOINT ["/usr/local/bin/openmapx-backup-subject-export"]
