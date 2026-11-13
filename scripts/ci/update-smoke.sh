#!/usr/bin/env bash
# Updates a real installation through a local registry and requires the
# documented behaviour of a self-update and of updates that fail part way.
#
#   scripts/ci/update-smoke.sh
#
# Release N is built from this checkout and pushed to a registry:2 container at
# localhost:5000/openmapx. Each later release is the previous release's images
# with one more label (a new digest each), plus a release manifest. Every case
# starts from a fresh installation of N, selected through the release channel
# exactly as an operator's installation is:
#
#   happy      an authenticated `system update` to N+1 succeeds, every role runs
#              the N+1 image and the operations agent is recreated last
#   registry   the registry is stopped after the check: the update fails before
#              maintenance and every service keeps its image
#   unhealthy  N+1's API image fails its health check: the update does not
#              succeed, nothing after the API and not the agent is recreated
#   helper     the configuration helper is killed after it recreated the
#              data-manager: the update does not succeed and is not re-run
#   agent      the agent is restarted while the helper runs: the helper still
#              finishes and the agent is recreated last
#   cli        `services restart` and `services start` while the helper runs exit
#              without interleaving a Compose effect, and succeed afterwards
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
registry_image="registry:2.8.3"
registry="localhost:5000/openmapx"
release_counter=0
cookie_file=""
admin_email="update-smoke@openmapx.org"
admin_password=""
release_images=(api web data-manager ops-agent transitous-runner transitous-tools)
cases="${UPDATE_SMOKE_CASES:-happy registry unhealthy helper agent cli}"

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

start_registry() {
  step "Start the local registry"
  docker rm --force "$registry_name" >/dev/null 2>&1 || true
  docker run --detach --name "$registry_name" --publish 5000:5000 "$registry_image" >/dev/null
  local deadline=$((SECONDS + 60))
  until curl --fail --silent http://localhost:5000/v2/ >/dev/null; do
    ((SECONDS < deadline)) || fail "the local registry did not answer"
    sleep 1
  done
}

stop_registry() { docker stop "$registry_name" >/dev/null; }
resume_registry() {
  docker start "$registry_name" >/dev/null
  local deadline=$((SECONDS + 60))
  until curl --fail --silent http://localhost:5000/v2/ >/dev/null; do
    ((SECONDS < deadline)) || fail "the local registry did not come back"
    sleep 1
  done
}

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

# Records each service's running image under a name, for comparisons.
snapshot_images() {
  local service
  : >"$work/images-$1"
  for service in "${expected_services[@]}"; do
    echo "$service $(image_id_of "$service")" >>"$work/images-$1"
  done
}

install_release_one() {
  reset_project
  configure_environment
  set_env OPENMAPX_RELEASE main
  set_env OPENMAPX_RELEASE_MANIFEST_REPOSITORY "$registry/release-manifest"
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
    --data "{\"email\":\"$admin_email\",\"password\":\"$admin_password\",\"name\":\"Update smoke\"}" \
    "$api/api/auth/sign-up/email" >/dev/null || fail "administrator sign-up failed"
  openmapx users verify "$admin_email" >/dev/null || fail "users verify failed"
  openmapx users promote "$admin_email" >/dev/null || fail "users promote failed"
  local jar="$work/cookies"
  curl --silent --show-error --insecure --fail --max-time 30 --cookie-jar "$jar" \
    --header "content-type: application/json" --header "origin: $api" \
    --data "{\"email\":\"$admin_email\",\"password\":\"$admin_password\"}" \
    "$api/api/auth/sign-in/email" >/dev/null || fail "administrator sign-in failed"
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
  local name="$1" release="$2" digest="$3"
  rm -f "$work/receipt-$name"
  NODE_TLS_REJECT_UNAUTHORIZED=0 logged "update-$name" openmapx system update \
    --release-id "$release" --digest "$digest" --session-file "$cookie_file" \
    --receipt "$work/receipt-$name" --api-origin https://localhost --no-backup
}

# Order in which helper containers recreated services, from Compose's events.
recreate_order() {
  docker events --since "$1" --until "$(date +%s)" --filter "type=container" --filter "event=start" \
    --filter "label=com.docker.compose.project=$project" \
    --format '{{index .Actor.Attributes "com.docker.compose.service"}}'
}

helper_container() {
  docker ps --all --quiet --filter "name=openmapx-configuration-handoff-" | head -1
}

# Waits for the helper to start and for a service to run the given release.
wait_helper_after() {
  local service="$1" release="$2" deadline=$((SECONDS + timeout_seconds)) helper="" want
  want="$(expected_image_id "$service" "$release")"
  until [[ -n "$helper" && "$(image_id_of "$service")" == "$want" ]]; do
    ((SECONDS < deadline)) || fail "the helper never recreated $service"
    helper="$(helper_container)"
    sleep 1
  done
  echo "$helper"
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

case_registry() {
  step "Case: registry outage after the check"
  install_release_one
  publish_release
  read -r release digest < <(check_release)
  snapshot_images before
  stop_registry
  if system_update registry "$release" "$digest"; then
    resume_registry
    fail "the update succeeded without a registry"
  fi
  resume_registry
  snapshot_images after
  diff -u "$work/images-before" "$work/images-after" || fail "a service changed its image"
  [[ -z "$(helper_container)" ]] || fail "a configuration helper was started"
  publish_release
  read -r release digest < <(check_release)
  system_update registry-retry "$release" "$digest" || fail "the next update was not admitted"
}

case_unhealthy() {
  step "Case: the new API image is unhealthy"
  install_release_one
  EXTRA_api='HEALTHCHECK --interval=5s --timeout=3s --retries=2 CMD ["false"]' publish_release
  read -r release digest < <(check_release)
  local agent_before
  agent_before="$(image_id_of ops-agent)"
  if system_update unhealthy "$release" "$digest"; then
    fail "the update succeeded although app-api is unhealthy"
  fi
  # The agent is the only release service recreated after the API.
  [[ "$(image_id_of ops-agent)" == "$agent_before" ]] || fail "the agent was replaced"
}

case_helper() {
  step "Case: the helper is killed after recreating the data-manager"
  install_release_one
  publish_release
  read -r release digest < <(check_release)
  system_update helper "$release" "$digest" &
  local updater=$! helper
  helper="$(wait_helper_after data-manager "$release")"
  docker kill "$helper" >/dev/null || true
  if wait "$updater"; then fail "the update succeeded although its helper was killed"; fi
  [[ "$(docker ps --all --quiet --filter "name=openmapx-configuration-handoff-" | wc -l)" -le 1 ]] ||
    fail "the helper was started again"
  [[ "$(image_id_of ops-agent)" != "$(expected_image_id ops-agent "$release")" ]] ||
    fail "the agent was replaced after its helper died"
}

case_agent() {
  step "Case: the agent restarts while the helper runs"
  install_release_one
  publish_release
  read -r release digest < <(check_release)
  local since
  since="$(date +%s)"
  system_update agent "$release" "$digest" &
  local updater=$!
  wait_helper_after data-manager "$release" >/dev/null
  docker restart "$(docker ps --quiet --filter "label=com.docker.compose.project=$project" \
    --filter "label=com.docker.compose.service=ops-agent")" >/dev/null
  wait "$updater" || fail "the update failed after the agent restarted"
  [[ "$(image_id_of ops-agent)" == "$(expected_image_id ops-agent "$release")" ]] ||
    fail "the agent does not run $release"
  [[ "$(recreate_order "$since" | grep -cv '^ops-agent$')" -ge 1 && "$(recreate_order "$since" | tail -1)" == ops-agent ]] ||
    fail "the agent was not recreated last"
}

case_cli() {
  step "Case: host lifecycle commands while the helper runs"
  install_release_one
  publish_release
  read -r release digest < <(check_release)
  system_update cli "$release" "$digest" &
  local updater=$! action
  wait_helper_after data-manager "$release" >/dev/null
  for action in restart start; do
    if logged "cli-$action" openmapx services "$action" app-web; then
      fail "services $action app-web succeeded while the helper ran"
    fi
  done
  wait "$updater" || fail "the update failed"
  for action in restart start; do
    logged "cli-$action-after" openmapx services "$action" app-web ||
      fail "services $action app-web failed after the update"
  done
}

# Removes the registry, then runs the install smoke's cleanup with the
# original exit status.
update_exit() {
  local status=$?
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
