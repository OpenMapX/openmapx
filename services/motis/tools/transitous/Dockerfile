FROM docker.io/golang:1.26@sha256:2005724102f45917a63e9d092fc0e4ea56ea575048ce147caad5f5f61502c365 AS build-gtfsclean
# Pin gtfsclean to a commit (the project only publishes rolling snapshot-N tags)
# instead of @latest so the build is reproducible and can't silently pull new code.
RUN GOPROXY=direct GOBIN=/usr/local/bin/ go install github.com/public-transport/gtfsclean@bb3ea74f66ef9bc07dc1bd038c3f653e10f0ade0 # snapshot-5

FROM docker.io/debian:bookworm-slim@sha256:7b140f374b289a7c2befc338f42ebe6441b7ea838a042bbd5acbfca6ec875818
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# Pin the MOTIS release we install. Override with `--build-arg MOTIS_VERSION=vX.Y.Z`.
# Keep this aligned with the `ghcr.io/motis-project/motis` image tag the
# `motis`/`motis-staging` services run and the `@motis-project/motis-client`
# version in package.json.
ARG MOTIS_VERSION=v2.11.0
# Per-arch SHA256 of the corresponding motis-linux-<arch>.tar.bz2 release
# asset. When non-empty for the target arch, the build fails if the
# downloaded tarball's hash differs — protects against an in-flight retag /
# yanked release silently pulling different bits. Empty defaults keep the
# build working without operators having to chase hashes for each MOTIS bump;
# CI should pass `--build-arg MOTIS_SHA256_<ARCH>=<hex>` for the arches it
# publishes.
ARG MOTIS_SHA256_AMD64=""
ARG MOTIS_SHA256_ARM64=""
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
RUN pip3 install --no-cache-dir -r /tmp/requirements.txt

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
    && if [ -n "$EXPECTED_SHA" ]; then \
         echo "${EXPECTED_SHA}  /tmp/motis.tar.bz2" | sha256sum -c -; \
       fi \
    && tar tjf /tmp/motis.tar.bz2 > /dev/null \
    && tar -C /opt/motis -xjf /tmp/motis.tar.bz2 \
    && rm -f /tmp/motis.tar.bz2

ENV PATH=/opt/motis:$PATH
ENV PYTHONDONTWRITEBYTECODE=1

WORKDIR /transitous
