# syntax=docker/dockerfile:1.7

# Keep the restore engine aligned with the deployment's reviewed PostgreSQL/PostGIS image.
FROM ghcr.io/baosystems/postgis:18-3.6@sha256:dd7515b7d8b8b8bac3516a9c3e12584df5890b0864c29295c1b934ecd1db81a7

# Apply distribution security fixes; this non-root entrypoint does not use gosu.
# The minimum Brotli version (CVE-2026-111497) fails a stale mirror and, when
# raised, invalidates this layer in the registry build cache.
RUN apt-get update && apt-get upgrade -y && \
    apt-get install -y --no-install-recommends python3 ca-certificates && \
    dpkg --compare-versions "$(dpkg-query -W -f='${Version}' libbrotli1)" ge 1.1.0-2+deb13u1 && \
    rm -rf /var/lib/apt/lists/* && \
    rm -f /usr/local/bin/gosu
COPY services/ops-agent/privacy-backup/openmapx-backup-subject-export.py /usr/local/bin/openmapx-backup-subject-export
RUN chmod 0555 /usr/local/bin/openmapx-backup-subject-export

USER postgres
ENTRYPOINT ["/usr/local/bin/openmapx-backup-subject-export"]
