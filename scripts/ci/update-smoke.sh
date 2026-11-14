#!/usr/bin/env bash
# Updates a real installation through a local registry and requires the
# documented behaviour of a self-update and of updates that fail part way.
#
#   scripts/ci/update-smoke.sh
#
# Release N is built from this checkout and pushed to a registry:2 container at
# localhost:5000/openmapx. The operations agent inspects release manifests with
# its own Docker CLI, inside its container, so before each update the agent is
# given what a production registry has without help:
#   - TLS: `docker manifest inspect` never falls back to plain HTTP, not even for
#     localhost. The registry serves a throwaway certificate, which the agent's
#     CLI trusts through /etc/docker/certs.d; the Docker daemon accepts it for
#     localhost without that.
#   - an address: localhost is the agent's container, so a forwarder in its
#     network namespace passes localhost:5000 on to the registry, which listens
#     on the host's network.
# The agent then inspects the candidate's image exactly as the update does, and
# the case fails at once, with the CLI's error, if it cannot.
#
# Each later release is the previous release's images with one more label (a
# new digest each), plus a release manifest. Every case starts from a fresh
# installation of N, selected through the release channel
# exactly as an operator's installation is:
#
#   happy      an authenticated `system update` to N+1 succeeds, every role runs
#              the N+1 image and the operations agent is recreated last
#   unhealthy  N+1's API image fails its health check: the update does not
#              succeed, nothing after the API and not the agent is recreated
#
# The script reuses scripts/ci/install-smoke.sh (sourced) and is as destructive:
# it removes the compose project "openmapx", the registry container and every
# ignored file under infra/docker. Run it on a Linux host with Docker Engine.
#
# UPDATE_SMOKE_CASES selects cases (default: all, in the order above).
# INSTALL_SMOKE_SKIP_BUILD=1 reuses images already tagged as the manifests name them.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=scripts/ci/install-smoke.sh
source "$root/scripts/ci/install-smoke.sh"

registry_name="openmapx-update-smoke-registry"
forwarder_name="openmapx-update-smoke-registry-forwarder"
registry_image="registry:2.8.3"
registry="localhost:5000/openmapx"
release_counter=0
cookie_file=""
registry_certs=""
update_timeout_seconds="${UPDATE_SMOKE_UPDATE_TIMEOUT_SECONDS:-1200}"
admin_email="update-smoke@openmapx.org"
admin_password=""
release_images=(api web data-manager ops-agent transitous-runner transitous-tools)
cases="${UPDATE_SMOKE_CASES:-happy unhealthy}"

service_of() {
  case "$1" in
    api) echo app-api ;;
    web) echo app-web ;;
    *) echo "$1" ;;
  esac
}

# The image this checkout builds for a release image name, as the manifests name it.
built_image() {
  if [[ "$1" == transitous-tools ]]; then
    echo "openmapx-update-smoke/transitous-tools:local"
  else
    manifest_image "$(service_of "$1")"
  fi
}

registry_up() {
  curl --fail --silent --max-time 5 --cacert "$registry_certs/registry.crt" \
    https://localhost:5000/v2/ >/dev/null
}

start_registry() {
  step "Start the local registry"
  docker rm --force "$registry_name" >/dev/null 2>&1 || true
  registry_certs="$work/registry-certs"
  mkdir -p "$registry_certs"
  openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj /CN=localhost \
    -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1" \
    -keyout "$registry_certs/registry.key" -out "$registry_certs/registry.crt" 2>/dev/null ||
    fail "could not create the registry certificate"
  # The registry runs as root and reads the key through its mount.
  chmod 644 "$registry_certs/registry.key"
  # Host networking, so the agent's network gateway reaches it on port 5000.
  docker run --detach --name "$registry_name" --network host \
    --volume "$registry_certs:/certs:ro" \
    --env REGISTRY_HTTP_TLS_CERTIFICATE=/certs/registry.crt \
    --env REGISTRY_HTTP_TLS_KEY=/certs/registry.key \
    "$registry_image" >/dev/null
  local deadline=$((SECONDS + 60))
  until registry_up; do
    ((SECONDS < deadline)) || fail "the local registry did not answer"
    sleep 1
  done
}

# The operations agent's container as it runs now; the self-update replaces it.
agent_container() {
  docker ps --quiet --filter "label=com.docker.compose.project=$project" \
    --filter "label=com.docker.compose.service=ops-agent" | head -1
}

# Gives the running operations agent what it needs to reach the registry as it
# reaches a production one, then checks it does with the candidate's image:
#   - the registry's certificate in /etc/docker/certs.d/localhost:5000, which
#     its Docker CLI trusts;
#   - a forwarder on localhost:5000 in its network namespace, to the registry
#     on the host through the agent network's gateway. It runs on the agent's
#     own image, which has Node.
# Called before every update, so a recreated agent gets both again.
prepare_agent_registry_access() {
  local release="$1" agent image gateway reference output
  stop_registry_forwarder
  agent="$(agent_container)"
  [[ -n "$agent" ]] || fail "no operations agent runs to give registry access to"
  docker exec --interactive --user 0 "$agent" sh -c \
    'mkdir -p /etc/docker/certs.d/localhost:5000 && cat >/etc/docker/certs.d/localhost:5000/ca.crt' \
    <"$registry_certs/registry.crt" || fail "could not give the operations agent the registry certificate"
  image="$(docker inspect --format '{{.Image}}' "$agent")"
  gateway="$(docker inspect --format '{{range .NetworkSettings.Networks}}{{.Gateway}} {{end}}' "$agent")"
  gateway="${gateway%% *}"
  [[ -n "$gateway" ]] || fail "the operations agent has no network gateway"
  docker run --detach --name "$forwarder_name" --network "container:$agent" --no-healthcheck \
    --entrypoint node "$image" -e '
    const net = require("node:net");
    const [, host, port] = process.argv;
    for (const address of ["127.0.0.1", "::1"])
      net
        .createServer((client) => {
          const upstream = net.connect(Number(port), host);
          client.pipe(upstream).pipe(client);
          upstream.on("error", () => client.destroy());
          client.on("error", () => upstream.destroy());
        })
        .on("error", (error) => {
          if (address === "127.0.0.1") throw error;
        })
        .listen(Number(port), address);
  ' "$gateway" 5000 >/dev/null || fail "could not start the registry forwarder for the operations agent"
  # While the registry is up (not in the outage case), the agent's own Docker
  # CLI must read the candidate's image from it, as the update's download does.
  registry_up || return 0
  reference="$registry/ops-agent:$release"
  local deadline=$((SECONDS + 30))
  until output="$(docker exec "$agent" timeout 20 docker manifest inspect "$reference" 2>&1)"; do
    ((SECONDS < deadline)) ||
      fail "the operations agent cannot read $reference from the registry: $(head -3 <<<"$output")"
    sleep 1
  done
}

stop_registry_forwarder() { docker rm --force "$forwarder_name" >/dev/null 2>&1 || true; }

# Pushes an image under a tag and prints its repository digest reference.
push_image() {
  local source="$1" name="$2" tag="$3" output digest
  docker tag "$source" "$registry/$name:$tag"
  output="$(docker push "$registry/$name:$tag")"
  digest="$(grep -oE 'digest: sha256:[a-f0-9]{64}' <<<"$output" | head -1 | cut -d' ' -f2)"
  [[ -n "$digest" ]] || fail "no digest for $registry/$name:$tag"
  echo "$registry/$name@$digest"
}

# Publishes the next release and points the followed channel (main) at it.
# Each image derives from the previous release's image; a Dockerfile fragment
# per image name can be added through EXTRA_<name> (dashes as underscores).
publish_release() {
  release_counter=$((release_counter + 1))
  local release="update-smoke-r$release_counter" name base extra var refs=()
  step "Publish release $release"
  for name in "${release_images[@]}"; do
    if ((release_counter == 1)); then
      base="$(built_image "$name")"
    else
      base="$registry/$name:update-smoke-r$((release_counter - 1))"
    fi
    var="EXTRA_${name//-/_}"
    extra="${!var:-}"
    printf 'FROM %s\nLABEL org.openmapx.update-smoke.release=%s\n%s\n' "$base" "$release" "$extra" |
      docker build --quiet --tag "openmapx-update-smoke/$name:$release" - >/dev/null
    refs+=("$name=$(push_image "openmapx-update-smoke/$name:$release" "$name" "$release")")
  done
  mkdir -p "$work/manifest-$release"
  RELEASE="$release" REFS="${refs[*]}" SOURCE_REVISION="$(git rev-parse HEAD)" node -e '
    const images = Object.fromEntries(process.env.REFS.split(" ").map((entry) => entry.split("=")));
    const builtAt = new Date().toISOString();
    const revision = process.env.SOURCE_REVISION;
    const manifest = {
      schemaVersion: 1,
      release: process.env.RELEASE,
      images,
      producer: { repository: "openmapx/openmapx", workflowPath: ".github/workflows/ci.yml",
        sourceRevision: revision, runId: 1, runAttempt: 1, event: "push" },
      buildMetadata: { version: 1, images: Object.fromEntries(Object.keys(images).map((name) =>
        [name, { sourceRevision: revision, inputHash: "0".repeat(64), builtAt, coldRefreshedAt: builtAt }])) },
    };
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  ' >"$work/manifest-$release/release-manifest.json"
  printf 'FROM scratch\nCOPY release-manifest.json /release-manifest.json\n' >"$work/manifest-$release/Dockerfile"
  docker build --quiet --tag "$registry/release-manifest:$release" "$work/manifest-$release" >/dev/null
  docker push --quiet "$registry/release-manifest:$release" >/dev/null
  docker tag "$registry/release-manifest:$release" "$registry/release-manifest:main"
  docker push --quiet "$registry/release-manifest:main" >/dev/null
  echo "$release" >"$work/current-release"
}

image_id_of() {
  local container
  container="$(docker ps --quiet --filter "label=com.docker.compose.project=$project" \
    --filter "label=com.docker.compose.service=$1" | head -1)"
  [[ -n "$container" ]] || return 0
  docker inspect --format '{{.Image}}' "$container"
}

expected_image_id() { docker image inspect --format '{{.Id}}' "$registry/$1:$2"; }

install_release_one() {
  stop_registry_forwarder
  reset_project
  configure_environment
  set_env OPENMAPX_RELEASE main
  set_env OPENMAPX_RELEASE_MANIFEST_REPOSITORY "$registry/release-manifest"
  # The first notable-places build starts right after the installation, runs
  # for minutes and holds the data-manager target: an update meanwhile is
  # refused (reported as a generic runtime failure). Each case tests the update.
  set_env NOTABLE_PLACES_REFRESH_CRON off
  release_counter=0
  publish_release
  step "Install release N"
  logged release openmapx compose release || fail "compose release failed"
  logged render openmapx compose render || fail "compose render failed"
  logged start openmapx services start postgis redis traefik app-api data-manager ||
    fail "services start failed"
  logged up openmapx compose up || fail "compose up failed"
  assert_stack_healthy
  [[ "$(image_id_of app-api)" == "$(expected_image_id api update-smoke-r1)" ]] ||
    fail "app-api does not run release N"
  create_admin_session
}

# An administrator account and its session cookie, as an operator creates them.
create_admin_session() {
  step "Create an administrator session"
  admin_password="$(openssl rand -hex 24)"
  local api="https://localhost"
  curl --silent --show-error --insecure --fail --max-time 30 \
    --header "content-type: application/json" --header "origin: $api" \
    --data @- "$api/api/auth/sign-up/email" >/dev/null \
    <<<"{\"email\":\"$admin_email\",\"password\":\"$admin_password\",\"name\":\"Update smoke\"}" ||
    fail "administrator sign-up failed"
  openmapx users verify "$admin_email" >/dev/null || fail "users verify failed"
  openmapx users promote "$admin_email" >/dev/null || fail "users promote failed"
  local jar="$work/cookies"
  curl --silent --show-error --insecure --fail --max-time 30 --cookie-jar "$jar" \
    --header "content-type: application/json" --header "origin: $api" \
    --data @- "$api/api/auth/sign-in/email" >/dev/null \
    <<<"{\"email\":\"$admin_email\",\"password\":\"$admin_password\"}" ||
    fail "administrator sign-in failed"
  cookie_file="$work/session-cookie"
  (umask 077 && awk '$6 ~ /better-auth\.session_token$/ { print $6 "=" $7 }' "$jar" >"$cookie_file")
  [[ -s "$cookie_file" ]] || fail "no session cookie was issued"
}

# Checks the published release and prints "<release id> <manifest digest>".
check_release() {
  local output release digest
  output="$(openmapx compose release --check 2>&1)" || fail "compose release --check failed: $output"
  release="$(sed -nE 's/.*Checked release: ([A-Za-z0-9._-]+).*/\1/p' <<<"$output" | head -1)"
  digest="$(sed -nE 's/.*Manifest digest: (sha256:)?([a-f0-9]{64}).*/\2/p' <<<"$output" | head -1)"
  [[ -n "$release" && -n "$digest" ]] || fail "could not read the checked release from: $output"
  echo "$release $digest"
}

# Runs the authenticated system update to the checked release. Returns its status.
system_update() {
  local name="$1" release="$2" digest="$3" status=0 follower
  rm -f "$work/receipt-$name"
  prepare_agent_registry_access "$release"
  follow_helpers "$name" &
  follower=$!
  # The CLI observes an update for up to an hour. One that has not finished
  # after update_timeout_seconds has stalled; the case fails then, with the
  # diagnostics of the stall.
  NODE_TLS_REJECT_UNAUTHORIZED=0 logged "update-$name" timeout "$update_timeout_seconds" \
    pnpm --silent openmapx system update \
    --release-id "$release" --digest "$digest" --session-file "$cookie_file" \
    --receipt "$work/receipt-$name" --api-origin https://localhost --no-backup || status=$?
  if ((status == 124)); then
    echo "✗ the update to $release did not finish within ${update_timeout_seconds}s" >&2
  fi
  kill "$follower" 2>/dev/null || true
  wait "$follower" 2>/dev/null || true
  return "$status"
}

# The agent starts configuration helpers with --rm, so their output is kept by
# following each one as it appears.
follow_helpers() {
  local name="$1" seen=" " helper
  while true; do
    for helper in $(docker ps --all --quiet --filter "name=openmapx-configuration-handoff-"); do
      [[ "$seen" == *" $helper "* ]] && continue
      seen+="$helper "
      docker logs --follow "$helper" >"$work/helper-$name-$helper.log" 2>&1 &
    done
    sleep 1
  done
}

# Order in which helper containers recreated services, from Compose's events.
recreate_order() {
  docker events --since "$1" --until "$(date +%s)" --filter "type=container" --filter "event=start" \
    --filter "label=com.docker.compose.project=$project" \
    --format '{{index .Actor.Attributes "com.docker.compose.service"}}'
}

case_happy() {
  step "Case: self-update to N+1"
  install_release_one
  publish_release
  read -r release digest < <(check_release)
  local since
  since="$(date +%s)"
  system_update happy "$release" "$digest" || fail "the update to $release failed"
  assert_stack_healthy
  local name
  for name in api data-manager ops-agent web transitous-runner; do
    [[ "$(image_id_of "$(service_of "$name")")" == "$(expected_image_id "$name" "$release")" ]] ||
      fail "$(service_of "$name") does not run $release"
  done
  [[ "$(recreate_order "$since" | tail -1)" == ops-agent ]] ||
    fail "the operations agent was not recreated last: $(recreate_order "$since" | tr '\n' ' ')"
}

case_unhealthy() {
  step "Case: the new API image is unhealthy"
  install_release_one
  # The service's own healthcheck (HTTP on the API's port) overrides any image
  # HEALTHCHECK, so N+1's API starts a process that never answers it.
  EXTRA_api=$'ENTRYPOINT ["node", "-e", "setInterval(() => {}, 1e9)"]\nCMD []' publish_release
  read -r release digest < <(check_release)
  local agent_before
  agent_before="$(image_id_of ops-agent)"
  # An update that cannot finish is held for the operator; ten minutes cover
  # the helper's wait for the API's health.
  if update_timeout_seconds=600 system_update unhealthy "$release" "$digest"; then
    fail "the update succeeded although app-api is unhealthy"
  fi
  # The agent is the only release service recreated after the API.
  [[ "$(image_id_of ops-agent)" == "$agent_before" ]] || fail "the agent was replaced"
}

# Removes the registry, then runs the install smoke's cleanup with the
# original exit status.
diagnostics_dir="${UPDATE_SMOKE_DIAGNOSTICS_DIR:-}"

# Writes what explains a failed case into $diagnostics_dir, before the install
# smoke's cleanup removes the containers: the latest administrative jobs as the
# API reports them (status, error and result, and each unfinished job alone with
# its observation), the agent's operations and the states its operation route
# reports, the CLI receipts, every container's state, and the logs of the
# roles and of every configuration helper, including exited ones. Secrets and environment files are not copied;
# the session cookie is only read by curl.
dump_diagnostics() {
  [[ -n "$diagnostics_dir" ]] || return 0
  mkdir -p "$diagnostics_dir"
  echo "--- writing update smoke diagnostics to $diagnostics_dir ---" >&2
  {
    echo "failed during: $current_step"
    echo "release counter: $release_counter"
  } >"$diagnostics_dir/summary.txt"
  if [[ -s "$work/cookies" ]]; then
    curl --silent --insecure --max-time 30 --cookie "$work/cookies" \
      --header "origin: https://localhost" \
      "https://localhost/api/admin/jobs?limit=10" >"$diagnostics_dir/admin-jobs.json" 2>&1 || true
    node -e '
      const jobs = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
      for (const job of jobs.jobs ?? jobs.items ?? jobs ?? [])
        console.log([job.id, job.type, job.status, job.error ?? "", JSON.stringify(job.result ?? null)].join("\t"));
    ' "$diagnostics_dir/admin-jobs.json" >"$diagnostics_dir/admin-jobs.tsv" 2>/dev/null || true
    # Each unfinished or failed job as the API describes it alone, with its
    # internal observation (state, reason, next check).
    local job_id
    while IFS=$'\t' read -r job_id _ job_status _; do
      [[ -n "$job_id" && "$job_status" != "success" ]] || continue
      curl --silent --insecure --max-time 30 --cookie "$work/cookies" \
        --header "origin: https://localhost" \
        "https://localhost/api/admin/jobs/$job_id" >"$diagnostics_dir/admin-job-$job_id.json" 2>&1 || true
    done <"$diagnostics_dir/admin-jobs.tsv"
  fi
  local receipt
  for receipt in "$work"/receipt-*; do
    if [[ -f "$receipt" ]]; then cp "$receipt" "$diagnostics_dir/" 2>/dev/null || true; fi
  done
  cp "$work"/*.log "$diagnostics_dir/" 2>/dev/null || true
  docker ps --all --format 'table {{.Names}}\t{{.Image}}\t{{.State}}\t{{.Status}}' \
    >"$diagnostics_dir/containers.txt" 2>&1 || true
  local agent reference
  agent="$(agent_container)"
  if [[ -n "$agent" ]] && ((release_counter > 0)); then
    # Whether the agent's own Docker CLI reads the newest release's image, as
    # an update's download does. A self-update replaces the agent, and the new
    # one has no certificate or forwarder until the next update.
    reference="$registry/ops-agent:update-smoke-r$release_counter"
    {
      echo "registry from the agent ($reference):"
      docker exec "$agent" timeout 20 docker manifest inspect "$reference" 2>&1 | head -3 ||
        echo "docker exec failed"
    } >>"$diagnostics_dir/summary.txt" 2>&1
  fi
  local container name
  while IFS= read -r container; do
    [[ -n "$container" ]] || continue
    name="$(docker inspect --format '{{.Name}}' "$container" 2>/dev/null | tr -d /)"
    docker logs --tail 400 "$container" >"$diagnostics_dir/logs-${name:-$container}.txt" 2>&1 || true
  done < <(
    docker ps --all --quiet --filter "label=com.docker.compose.project=$project" \
      --filter "label=com.docker.compose.service=ops-agent"
    docker ps --all --quiet --filter "label=com.docker.compose.project=$project" \
      --filter "label=com.docker.compose.service=app-api"
    docker ps --all --quiet --filter "label=com.docker.compose.project=$project" \
      --filter "label=com.docker.compose.service=data-manager"
    docker ps --all --quiet --filter "name=openmapx-configuration-handoff-"
  )
}

update_exit() {
  local status=$?
  if ((status != 0)); then dump_diagnostics || true; fi
  stop_registry_forwarder
  docker rm --force "$registry_name" >/dev/null 2>&1 || true
  (exit "$status")
  on_exit
}

update_main() {
  step "Check preconditions"
  local tool
  for tool in docker node openssl pnpm curl awk git; do
    command -v "$tool" >/dev/null || fail "$tool is required"
  done
  docker info >/dev/null 2>&1 || fail "the Docker daemon is not reachable"
  [[ ! -e "$env_file" ]] || fail "$env_file already exists; this check only runs on a fresh checkout"
  [[ -z "$(project_containers)" ]] || fail "the compose project '$project' already has containers"

  work="$(mktemp -d)"
  trap update_exit EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  build_images
  step "Build openmapx-update-smoke/transitous-tools:local"
  docker build --quiet --tag "$(built_image transitous-tools)" services/motis/tools/transitous >/dev/null
  pull_third_party_images
  start_registry
  local name
  for name in $cases; do
    "case_$name"
  done
  step "Done"
  echo "Update smoke check passed: $cases"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  update_main "$@"
fi
