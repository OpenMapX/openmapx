FROM docker.io/golang:1.27.4@sha256:205c7636d74e0ffbe3d007162df7d74f859f5a8c8322dfb9f907977686c126cf AS build-gtfsclean
# Pin gtfsclean to a commit (the project only publishes rolling snapshot-N tags)
# instead of @latest so the build is reproducible and can't silently pull new code.
WORKDIR /tmp/gtfsclean-build
COPY --chmod=0755 build-gtfsclean.sh /usr/local/bin/build-gtfsclean
RUN build-gtfsclean

FROM docker.io/debian:trixie-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# Pin the MOTIS release we install. Override with `--build-arg MOTIS_VERSION=vX.Y.Z`.
# Keep this aligned with the `ghcr.io/motis-project/motis` image tag the
# `motis`/`motis-staging` services run and the `@motis-project/motis-client`
# version in package.json.
ARG MOTIS_VERSION=v2.11.4
# Reviewed per-architecture SHA256 values for the corresponding release assets.
# A MOTIS bump must update both values; an unchecked build is never permitted.
ARG MOTIS_SHA256_AMD64=b521bb29c961a3b994ff4dac663778ba64fee7b4cfaf3f2b20ff1d5e1d15e0dc
ARG MOTIS_SHA256_ARM64=76f41df5bb4db14ccd163dad0a23dd85bebbb9f21a9736834e9b3d4201080f3b
# `TARGETARCH` is auto-populated by BuildKit when building with buildx
# (including for multi-platform manifests). Declaring it here makes it
# available inside the RUN below.
ARG TARGETARCH

# Explicitly upgrade PCRE2, Expat and Brotli inherited from the pinned base,
# and libssl3t64 and openssl (3.5.7-1~deb13u3 fixes CVE-2026-84782,
# DSA-6531-1) that curl, git, Python and ca-certificates pull in, to their
# security fixes. Expat 2.9.0-1~deb13u1 fixes CVE-2026-77214 (DSA-6566-1);
# Brotli 1.1.0-2+deb13u1 fixes CVE-2026-111497 (DSA-6582-1). Trixie's PCRE2
# 10.46-1~deb13u2 point release already fixes CVE-2026-86145, CVE-2026-89157
# and CVE-2026-89161, so it needs no floor. The version checks fail a stale
# mirror and, when raised, invalidate this layer in the registry build cache.
# apt and libapt-pkg7.0 3.0.4 fix CVE-2026-109518 (Debian DSA-6607-1).
# zlib1g 1:1.3.dfsg+really1.3.1-1+deb13u1 fixes CVE-2026-76844 and CVE-2026-85091.
RUN apt-get update -y \
    && apt-get install -y --no-install-recommends \
      git python3-pip python3-venv curl wget bzip2 rsync openssh-client ca-certificates age apt libapt-pkg7.0 libpcre2-8-0 libexpat1 libbrotli1 libssl3t64 openssl zlib1g \
    && dpkg --compare-versions "$(dpkg-query -W -f='${Version}' apt)" ge 3.0.4 \
    && dpkg --compare-versions "$(dpkg-query -W -f='${Version}' libapt-pkg7.0)" ge 3.0.4 \
    && dpkg --compare-versions "$(dpkg-query -W -f='${Version}' libexpat1)" ge 2.9.0-1~deb13u1 \
    && dpkg --compare-versions "$(dpkg-query -W -f='${Version}' libbrotli1)" ge 1.1.0-2+deb13u1 \
    && dpkg --compare-versions "$(dpkg-query -W -f='${Version}' libssl3t64)" ge 3.5.7-1~deb13u3 \
    && dpkg --compare-versions "$(dpkg-query -W -f='${Version}' openssl)" ge 3.5.7-1~deb13u3 \
    && dpkg --compare-versions "$(dpkg-query -W -f='${Version}' zlib1g)" ge 1:1.3.dfsg+really1.3.1-1+deb13u1 \
    && apt-get clean -y \
    && rm -rf /var/lib/apt/lists/* \
    && rm -f /usr/lib/python3.*/EXTERNALLY-MANAGED

COPY requirements.txt /tmp/requirements.txt
RUN pip3 install --no-cache-dir --require-hashes -r /tmp/requirements.txt

COPY --from=build-gtfsclean /usr/local/bin/gtfsclean /usr/local/bin/gtfsclean

# Download + (optionally) verify + extract the MOTIS release. Splitting the
# download from the extract lets us checksum the tarball before trusting it.
# `tar tjf` at the end verifies bzip2 integrity either way, so truncation
# from a flaky connection surfaces here instead of silently shipping a
# half-extracted /opt/motis. The tarball URL is selected from TARGETARCH so
# multi-arch buildx builds land the correct binary in each platform's image.
RUN mkdir -p /opt/motis \
    && case "${TARGETARCH:-amd64}" in \
         amd64) MOTIS_ARCH=amd64; EXPECTED_SHA="$MOTIS_SHA256_AMD64" ;; \
         arm64) MOTIS_ARCH=arm64; EXPECTED_SHA="$MOTIS_SHA256_ARM64" ;; \
         *) echo "Unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
       esac \
    && wget -qO /tmp/motis.tar.bz2 \
       "https://github.com/motis-project/motis/releases/download/${MOTIS_VERSION}/motis-linux-${MOTIS_ARCH}.tar.bz2" \
    && echo "${EXPECTED_SHA}  /tmp/motis.tar.bz2" | sha256sum -c - \
    && tar tjf /tmp/motis.tar.bz2 > /dev/null \
    && tar -C /opt/motis -xjf /tmp/motis.tar.bz2 \
    && rm -f /tmp/motis.tar.bz2

ENV PATH=/opt/motis:$PATH
ENV PYTHONDONTWRITEBYTECODE=1

# The step runner the CLI calls (packages/cli/src/lib/motis-data.ts), part of
# the release rather than mounted from the host checkout.
COPY --chmod=0755 run.sh /usr/local/bin/openmapx-transitous

WORKDIR /transitous
