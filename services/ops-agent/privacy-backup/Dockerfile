# syntax=docker/dockerfile:1.7

# Keep the restore engine aligned with the deployment's reviewed PostgreSQL/PostGIS image.
FROM ghcr.io/baosystems/postgis:18-3.6@sha256:4aa511a2eb5cf79b2f6309292ab5ba4dd64a43c42ddaadabc86de71bc6a81b64

# Apply distribution security fixes; this non-root entrypoint does not use gosu.
# The minimum Brotli version (CVE-2026-111497) fails a stale mirror and, when
# raised, invalidates this layer in the registry build cache.
# apt and libapt-pkg7.0 3.0.4 fix CVE-2026-109518 (Debian DSA-6607-1).
# zlib1g and libminizip1t64 require Debian's fixed revision for CVE-2026-76844
# and CVE-2026-85091; these floors also invalidate previously cached upgrades.
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
    dpkg --compare-versions "$(dpkg-query -W -f='${Version}' apt)" ge 3.0.4 && \
    dpkg --compare-versions "$(dpkg-query -W -f='${Version}' libapt-pkg7.0)" ge 3.0.4 && \
    dpkg --compare-versions "$(dpkg-query -W -f='${Version}' libbrotli1)" ge 1.1.0-2+deb13u1 && \
    dpkg --compare-versions "$(dpkg-query -W -f='${Version}' zlib1g)" ge 1:1.3.dfsg+really1.3.1-1+deb13u1 && \
    dpkg --compare-versions "$(dpkg-query -W -f='${Version}' libminizip1t64)" ge 1:1.3.dfsg+really1.3.1-1+deb13u1 && \
    [ "$(dpkg-query -W -f='${Version}' postgresql-18-postgis-3)" = \
      "$(dpkg-query -W -f='${Version}' postgresql-18-postgis-3-scripts)" ] && \
    rm -rf /var/lib/apt/lists/* && \
    rm -f /usr/local/bin/gosu
COPY services/ops-agent/privacy-backup/openmapx-backup-subject-export.py /usr/local/bin/openmapx-backup-subject-export
RUN chmod 0555 /usr/local/bin/openmapx-backup-subject-export

USER postgres
ENTRYPOINT ["/usr/local/bin/openmapx-backup-subject-export"]
