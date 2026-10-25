FROM docker.io/golang:1.27.3@sha256:f20d83a83e18dbd2a4714b8ffd4b30b287b6243962dd75608e86abcc63ba4efc AS build-gtfsclean
# Pin gtfsclean to a commit (the project only publishes rolling snapshot-N tags)
# instead of @latest so the build is reproducible and can't silently pull new code.
WORKDIR /tmp/gtfsclean-build
COPY --chmod=0755 build-gtfsclean.sh /usr/local/bin/build-gtfsclean
RUN build-gtfsclean

FROM docker.io/debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# Pin the MOTIS release we install. Override with `--build-arg MOTIS_VERSION=vX.Y.Z`.
# Keep this aligned with the `ghcr.io/motis-project/motis` image tag the
# `motis`/`motis-staging` services run and the `@motis-project/motis-client`
# version in package.json.
ARG MOTIS_VERSION=v2.11.3
# Reviewed per-architecture SHA256 values for the corresponding release assets.
# A MOTIS bump must update both values; an unchecked build is never permitted.
ARG MOTIS_SHA256_AMD64=0ffc7fc0633049edbcf88170ac037d2665ceaf1f0884a00b15f6c2b81313c825
ARG MOTIS_SHA256_ARM64=eda48ad1744e7be9bdd1cb515e7229e9c7ecdc3cf82c6621a64670505b3d485b
# `TARGETARCH` is auto-populated by BuildKit when building with buildx
# (including for multi-platform manifests). Declaring it here makes it
# available inside the RUN below.
ARG TARGETARCH

# Explicitly upgrade PCRE2, Expat and Brotli inherited from the pinned base to
# their security fixes. The version checks fail a stale mirror and, when raised,
# invalidate this layer in the registry build cache.
RUN apt-get update -y \
    && apt-get install -y --no-install-recommends \
      git python3-pip python3-venv curl wget bzip2 rsync openssh-client ca-certificates age libpcre2-8-0 libexpat1 libbrotli1 \
    && dpkg --compare-versions "$(dpkg-query -W -f='${Version}' libexpat1)" ge 2.5.0-1+deb12u5 \
    && dpkg --compare-versions "$(dpkg-query -W -f='${Version}' libbrotli1)" ge 1.0.9-2+deb12u1 \
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
