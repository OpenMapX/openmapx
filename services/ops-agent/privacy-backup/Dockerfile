# syntax=docker/dockerfile:1.7

# Keep the restore engine aligned with the deployment's reviewed PostgreSQL/PostGIS image.
FROM ghcr.io/baosystems/postgis:18-3.6@sha256:dd7515b7d8b8b8bac3516a9c3e12584df5890b0864c29295c1b934ecd1db81a7

# Apply distribution security fixes; this non-root entrypoint does not use gosu.
# The minimum Brotli version (CVE-2026-111497) fails a stale mirror and, when
# raised, invalidates this layer in the registry build cache.
# PostgreSQL, PostGIS and libpq stay at the pinned image's versions: the restore
# engine must match the deployment's, and the PostgreSQL repository can publish
# a PostGIS release's SQL scripts before its library (3.7.0 scripts over the
# 3.6.4 library made every restore fail on 2026-10-30). The build stops if the
# PostGIS library and scripts ever differ.
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
RUN apt-get update && \
    dpkg-query -W -f='${db:Status-Abbrev} ${binary:Package}\n' 'postgresql*' 'postgis*' 'libpq*' | \
      awk '$1 == "ii" { print $2 }' | xargs apt-mark hold && \
    apt-get upgrade -y && \
    apt-get install -y --no-install-recommends python3 ca-certificates && \
    dpkg --compare-versions "$(dpkg-query -W -f='${Version}' libbrotli1)" ge 1.1.0-2+deb13u1 && \
    [ "$(dpkg-query -W -f='${Version}' postgresql-18-postgis-3)" = \
      "$(dpkg-query -W -f='${Version}' postgresql-18-postgis-3-scripts)" ] && \
    rm -rf /var/lib/apt/lists/* && \
    rm -f /usr/local/bin/gosu
COPY services/ops-agent/privacy-backup/openmapx-backup-subject-export.py /usr/local/bin/openmapx-backup-subject-export
RUN chmod 0555 /usr/local/bin/openmapx-backup-subject-export

USER postgres
ENTRYPOINT ["/usr/local/bin/openmapx-backup-subject-export"]
