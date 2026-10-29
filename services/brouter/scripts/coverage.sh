#!/usr/bin/env bash
# Sourced by the supervisor and exercised without a JVM by the portable tests.
normalize_region() {
  local region="${1:-}"
  [[ "$region" == germany ]] && region=europe/germany
  if [[ ! "$region" =~ ^[a-z][a-z0-9-]*(/[a-z][a-z0-9-]*)*$ ]]; then
    echo 'Invalid REGION: use planet or a Geofabrik extract path' >&2
    return 1
  fi
  printf '%s\n' "$region"
}

region_bounds() {
  awk '
    NF == 2 && $1 ~ /^[-+0-9.]+([Ee][-+0-9]+)?$/ && $2 ~ /^[-+0-9.]+([Ee][-+0-9]+)?$/ {
      x=$1+0; y=$2+0
      if (x < -180 || x > 180 || y < -90 || y > 90) { bad=1; exit }
      if (!n++ || x < west) west=x
      if (n == 1 || x > east) east=x
      if (n == 1 || y < south) south=y
      if (n == 1 || y > north) north=y
    }
    END { if (bad || !n) exit 1; print west, south, east, north }
  ' "$1"
}

select_segments() {
  local index="$1" bounds="$2"
  sed 's/<[^>]*>/ /g; s/\r//g' "$index" | awk -v bounds="$bounds" '
    BEGIN { split(bounds,b," ") }
    $1 ~ /^[EW][0-9]+_[NS][0-9]+\.rd5$/ && $NF ~ /^[0-9]+$/ && $NF > 0 {
      split($1, parts, "_")
      x=substr(parts[1],2)+0; if (substr(parts[1],1,1)=="W") x=-x
      y=substr(parts[2],2)+0; if (substr(parts[2],1,1)=="S") y=-y
      if (x < -180 || x >= 180 || y < -90 || y >= 90 || x % 5 || y % 5) next
      if (bounds == "planet" || (x < b[3] && x+5 > b[1] && y < b[4] && y+5 > b[2])) {
        if (seen[$1]++) next
        print $1, $NF; n++
      }
    }
    END { if (!n) exit 1 }
  '
}

fetch_file() {
  curl --fail --silent --show-error --location --retry 2 --retry-delay 2 \
    --connect-timeout 20 --max-time 1800 --max-filesize "$3" --output "$2" "$1" &
  transfer_pid=$!
  local status=0
  wait "$transfer_pid" || status=$?
  transfer_pid=
  return "$status"
}

prepare_generation() {
  set -euo pipefail
  local root="$1" region="$2" base="$3" lookup_url="$4" bounds name bytes available required
  mkdir -p "$root"
  # Keep the trap path in process scope: Bash 3 unwinds locals before EXIT.
  stage=$(mktemp -d "$root/.staging-XXXXXX")
  transfer_pid=
  trap '[[ -z "$transfer_pid" ]] || kill "$transfer_pid" 2>/dev/null; rm -rf "$stage"' EXIT
  trap 'exit 143' TERM
  trap 'exit 130' INT
  bounds=planet
  if [[ "$region" != planet ]]; then
    fetch_file "https://download.geofabrik.de/$region.poly" "$stage/region.poly" 10000000
    bounds=$(region_bounds "$stage/region.poly")
  fi
  fetch_file "$base" "$stage/index.html" 5000000
  select_segments "$stage/index.html" "$bounds" > "$stage/segments.list"
  required=$(awk '{sum+=$2} END {printf "%.0f",sum+1073741824}' "$stage/segments.list")
  available=$(df -Pk "$root" | awk 'END {printf "%.0f", $4*1024}')
  if (( available < required )); then
    echo "Not enough free disk for staged BRouter coverage (requires $required bytes including reserve)" >&2
    exit 1
  fi
  mkdir "$stage/segments4" "$stage/profiles2"
  while read -r name bytes; do
    echo "Downloading BRouter segment $name ($bytes bytes)" >&2
    fetch_file "$base$name" "$stage/segments4/$name" "$bytes"
    if [[ $(wc -c < "$stage/segments4/$name" | tr -d ' ') != "$bytes" ]]; then
      echo "Incomplete BRouter segment: $name" >&2
      exit 1
    fi
  done < "$stage/segments.list"
  fetch_file "$lookup_url" "$stage/profiles2/lookups.dat" 1000000
  grep -q '^---lookupversion:' "$stage/profiles2/lookups.dat" || {
    echo 'Invalid BRouter lookup table' >&2; exit 1;
  }
  printf '%s\n' "$region" > "$stage/region"
  date +%s > "$stage/updated-at"
  local lookup_version segment_version
  lookup_version=$(sed -n 's/^---lookupversion://p' "$stage/profiles2/lookups.dat" | head -1)
  [[ "$lookup_version" =~ ^[0-9]+$ ]] || exit 1
  while read -r name bytes; do
    segment_version=$(od -An -tu1 -N2 "$stage/segments4/$name" | awk 'NF == 2 {print $1*256+$2}')
    [[ "$segment_version" == "$lookup_version" ]] || {
      echo "BRouter segment/lookup version mismatch: $name" >&2; exit 1;
    }
  done < "$stage/segments.list"
  local generation="$root/generation-${stage##*staging-}"
  mv "$stage" "$generation"
  printf '%s\n' "$generation"
}

publish_generation() {
  local root="$1" generation="$2" next
  [[ "$generation" == "$root"/generation-* && -s "$generation/region" ]] || return 1
  next="$root/.next-$$"
  ln -s "${generation##*/}" "$next"
  if [[ $(uname) == Darwin ]]; then
    mv -fh "$next" "$root/current"
  else
    mv -Tf "$next" "$root/current"
  fi
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  prepare_generation "$@"
fi
