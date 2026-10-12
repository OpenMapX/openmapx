#!/bin/sh
set -eu

retry_fetch() {
  attempt=1
  while true; do
    if "$@"; then
      return 0
    fi
    if [ "$attempt" -ge 4 ]; then
      return 1
    fi
    echo "gtfsclean dependency fetch failed; retrying attempt $((attempt + 1)) of 4" >&2
    sleep "$((attempt * 2))"
    attempt=$((attempt + 1))
  done
}

export GOPROXY=direct
go mod init openmapx.local/gtfsclean-build
retry_fetch go get github.com/public-transport/gtfsclean@013af793337b759e782c3f8919e0b535cb702944
retry_fetch go get golang.org/x/text@v0.39.0
go build -trimpath -o /usr/local/bin/gtfsclean github.com/public-transport/gtfsclean
