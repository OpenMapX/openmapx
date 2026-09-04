FROM docker.io/golang:1.27@sha256:4013ae0f9e7994f8535c58c811f8f863fbed38b72e0d51e6592156f758d66146 AS build-gtfsclean
# Pin gtfsclean to a commit (the project only publishes rolling snapshot-N tags)
# instead of @latest so the build is reproducible and can't silently pull new code.
WORKDIR /tmp/gtfsclean-build
RUN GOPROXY=direct go mod init openmapx.local/gtfsclean-build && \
    GOPROXY=direct go get github.com/public-transport/gtfsclean@bb3ea74f66ef9bc07dc1bd038c3f653e10f0ade0 && \
    GOPROXY=direct go get golang.org/x/text@v0.39.0 && \
    GOPROXY=direct go build -trimpath -o /usr/local/bin/gtfsclean github.com/public-transport/gtfsclean

FROM docker.io/debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# Pin the MOTIS release we install. Override with `--build-arg MOTIS_VERSION=vX.Y.Z`.
# Keep this aligned with the `ghcr.io/motis-project/motis` image tag the
# `motis`/`motis-staging` services run and the `@motis-project/motis-client`
# version in package.json.
ARG MOTIS_VERSION=v2.11.0
# Reviewed per-architecture SHA256 values for the corresponding release assets.
# A MOTIS bump must update both values; an unchecked build is never permitted.
ARG MOTIS_SHA256_AMD64=508505d3f9cd2e872c763743c459cae4e0539fad14bf490e23251e013d3a6dfa
ARG MOTIS_SHA256_ARM64=23aa8fd6568741e2bf35f92fb88b3c5c64baa1e05b3cb31f28ccdbe73ba6a110
# `TARGETARCH` is auto-populated by BuildKit when building with buildx
# (including for multi-platform manifests). Declaring it here makes it
# available inside the RUN below.
ARG TARGETARCH

RUN apt-get update -y \
    && apt-get install -y --no-install-recommends \
      git python3-pip python3-venv curl wget bzip2 rsync openssh-client ca-certificates age \
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

WORKDIR /transitous
