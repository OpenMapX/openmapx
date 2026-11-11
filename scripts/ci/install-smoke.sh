#!/usr/bin/env bash
# Follows the documented fresh install against images built from this checkout
# and requires the stack to come up healthy and owned by the deployment user.
#
#   scripts/ci/install-smoke.sh
#
# Two fresh projects run in turn. The first renders the default selection,
# starts the infrastructure, checks the data-manager and file ownership, then
# brings up the whole stack. The second occupies port 80, requires the start to
# fail, frees the port and requires the retry to succeed.
#
# The script is destructive: it removes the compose project named "docker" and
# every ignored file under infra/docker when it finishes. It refuses to run
# where infra/docker/.env or that project already exists. Run it on a Linux host
# with Docker Engine; building the web image needs about 8 GiB of memory.
#
# INSTALL_SMOKE_SKIP_BUILD=1 reuses images already tagged as the manifests name
# them. INSTALL_SMOKE_TIMEOUT_SECONDS bounds each wait (default 600).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"

infra="infra/docker"
env_file="$infra/.env"
project="docker"
timeout_seconds="${INSTALL_SMOKE_TIMEOUT_SECONDS:-600}"
work=""
blocker="openmapx-install-smoke-port-80-$$"
current_step="starting"

# First-party image of each service, as the manifests name it; the five
# services whose images this checkout builds.
built_services=(app-api app-web ops-agent data-manager transitous-runner)
# The default selection and its dependencies.
expected_services=(traefik well-known app-api app-web postgis redis data-manager ops-agent transitous-runner)

dockerfile_of() {
  case "$1" in
    app-api) echo apps/api/Dockerfile ;;
    app-web) echo apps/web/Dockerfile ;;
    ops-agent) echo apps/ops-agent/Dockerfile ;;
    data-manager) echo services/data-manager/Dockerfile ;;
    transitous-runner) echo apps/transitous-runner/Dockerfile ;;
    *) fail "no Dockerfile is known for $1" ;;
  esac
}

step() {
  current_step="$1"
  echo "==> $1"
}

fail() {
  echo "Install smoke check failed: $1" >&2
  exit 1
}

project_containers() {
  docker ps --all --quiet --filter "label=com.docker.compose.project=$project"
}

# Removes the project's containers, networks and volumes, then the generated
# files under infra/docker. A file a container created as root needs sudo.
reset_project() {
  docker rm --force "$blocker" >/dev/null 2>&1 || true
  project_containers | xargs -r docker rm --force --volumes >/dev/null 2>&1 || true
  docker network ls --quiet --filter "label=com.docker.compose.project=$project" |
    xargs -r docker network rm >/dev/null 2>&1 || true
  docker volume ls --quiet --filter "label=com.docker.compose.project=$project" |
    xargs -r docker volume rm >/dev/null 2>&1 || true
  local generated
  while IFS= read -r generated; do
    [[ -n "$generated" ]] || continue
    remove_generated "$generated"
  done < <(git ls-files --others --ignored --exclude-standard --directory -- "$infra")
}

# A path a container created as root cannot be removed by the deployment user:
# try sudo, then a container of an image the stack already uses.
remove_generated() {
  rm -rf -- "$1" 2>/dev/null && return 0
  sudo -n rm -rf -- "$1" 2>/dev/null && return 0
  docker run --rm --volume "$root/$infra:/infra" --entrypoint rm "$(manifest_image redis)" \
    -rf -- "/infra/${1#"$infra"/}" >/dev/null 2>&1 || true
}

# Logs are the only place a failed start explains itself, so each container's
# tail goes out with its state. Environment variables are never printed.
print_diagnostics() {
  echo "--- container states ---" >&2
  docker ps --all --filter "label=com.docker.compose.project=$project" \
    --format 'table {{.Names}}\t{{.State}}\t{{.Status}}' >&2 || true
  local container
  while IFS= read -r container; do
    [[ -n "$container" ]] || continue
    echo "--- last log lines of $(docker inspect --format '{{.Name}}' "$container") ---" >&2
    docker logs --tail 40 "$container" >&2 2>&1 || true
  done < <(project_containers)
}

on_exit() {
  local status=$?
  trap - EXIT
  if ((status != 0)); then
    echo "Install smoke check failed during: $current_step" >&2
    print_diagnostics
  fi
  reset_project
  [[ -z "$work" ]] || rm -rf "$work"
  exit "$status"
}
openmapx() {
  pnpm --silent openmapx "$@"
}

# Runs a command, shows its output and keeps it in $work/$1.log for assertions.
# Returns the command's status.
logged() {
  local name="$1"
  shift
  set +e
  "$@" 2>&1 | tee "$work/$name.log"
  local status=${PIPESTATUS[0]}
  set -e
  return "$status"
}

manifest_image() {
  node -e '
    const { container: c } = require(process.argv[1]);
    console.log(`${c.image}:${c.tag}${c.digest ? `@${c.digest}` : ""}`);
  ' "$root/services/$1/service.json"
}

# Replaces KEY= in the env file, or the commented template line, or appends it.
# The value travels in the environment so it never appears in a process list.
set_env() {
  local key="$1" value="$2" pattern tmp
  if grep -q "^$key=" "$env_file"; then
    pattern="^$key="
  elif grep -q "^# \{0,1\}$key=" "$env_file"; then
    pattern="^# ?$key="
  else
    pattern=""
  fi
  tmp="$(mktemp "$env_file.XXXXXX")"
  KEY="$key" VALUE="$value" PATTERN="$pattern" awk '
    BEGIN { done = 0 }
    !done && ENVIRON["PATTERN"] != "" && $0 ~ ENVIRON["PATTERN"] {
      print ENVIRON["KEY"] "=" ENVIRON["VALUE"]
      done = 1
      next
    }
    { print }
    END { if (!done) print ENVIRON["KEY"] "=" ENVIRON["VALUE"] }
  ' "$env_file" >"$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$env_file"
}

# Writes a fresh random secret to KEY. A hosted run masks the value first, in
# the caller: the mask command must reach the runner's log, and a command
# substitution would swallow it and put it in the value.
set_env_secret() {
  local secret
  secret="$(openssl rand -hex 32)"
  [[ -z "${GITHUB_ACTIONS:-}" ]] || echo "::add-mask::$secret"
  set_env "$1" "$secret"
}

docker_socket_gid() {
  stat -c %g /var/run/docker.sock 2>/dev/null || stat -f %g /var/run/docker.sock
}

# Pulled up front so the start steps stay readable and a slow registry does not
# count against their waits.
pull_third_party_images() {
  step "Pull the third-party images"
  local service
  for service in postgis redis traefik well-known; do
    docker pull --quiet "$(manifest_image "$service")" >/dev/null
  done
}

build_images() {
  local service image
  for service in "${built_services[@]}"; do
    image="$(manifest_image "$service")"
    if [[ -n "${INSTALL_SMOKE_SKIP_BUILD:-}" ]]; then
      docker image inspect "$image" >/dev/null 2>&1 || fail "image $image is not available locally"
      continue
    fi
    step "Build $image"
    docker build --file "$(dockerfile_of "$service")" --tag "$image" .
  done
}

# Documented steps 1 and 2: protect the checkout, then write an env file from
# the template with fresh random secrets. Nothing here is printed.
configure_environment() {
  step "Install dependencies and write the environment"
  pnpm install --frozen-lockfile
  chmod go-w . infra "$infra" "$infra/secrets"
  cp "$infra/.env.example" "$env_file"
  chmod 600 "$env_file"
  set_env DOMAIN localhost
  set_env ACME_EMAIL install-smoke@openmapx.org
  set_env_secret POSTGRES_PASSWORD
  set_env_secret BETTER_AUTH_SECRET
  set_env_secret OPENMAPX_SECRETS_KEY
  set_env_secret DATA_MANAGER_AUTH_TOKEN
  set_env_secret OPENMAPX_LOCAL_ADMIN_TOKEN
  set_env OPENMAPX_HOST_DIR "$root"
  set_env DOCKER_GID "$(docker_socket_gid)"
  set_env TRANSITOUS_COUNTRIES de
  set_env TRANSITOUS_SYNC_CRON disabled
  set_env OPENMAPX_RELEASE local
}

# Documented steps 3 and 4. The release selection is local, so there is no
# release to resolve: the services use the images built above.
render_stack() {
  step "Render the compose stack"
  logged selected openmapx services selected || fail "services selected failed"
  logged release-status openmapx compose release --status || fail "compose release --status failed"
  logged render openmapx compose render || fail "compose render failed"
}

# Documented step 5, after the start itself.
assert_data_manager_status() {
  step "Check the data-manager status"
  local deadline=$((SECONDS + timeout_seconds)) body=""
  until body="$(curl --fail --silent --show-error --max-time 10 http://localhost:4000/status 2>/dev/null)"; do
    ((SECONDS < deadline)) || fail "http://localhost:4000/status did not answer within ${timeout_seconds}s"
    sleep 3
  done
  BODY="$body" node -e '
    const status = JSON.parse(process.env.BODY);
    if (status.ok !== true || status.dataDir !== "/data") {
      console.error(`unexpected status: ok=${status.ok} dataDir=${status.dataDir}`);
      process.exit(1);
    }
  ' || fail "the data-manager status does not report ok with dataDir /data"
}

# `check` logs ownership problems as errors without failing the command, so the
# assertion reads its output as well as its status.
assert_check_clean() {
  step "Check the deployment with openmapx check"
  local status=0
  logged check openmapx check --no-probe || status=$?
  ((status == 0)) || fail "openmapx check exited with $status"
  if grep -q '✗' "$work/check.log"; then
    echo "--- problems reported by openmapx check ---" >&2
    grep '✗' "$work/check.log" >&2
    fail "openmapx check reported problems"
  fi
}

# Every container of the project is running and, where it has a healthcheck,
# healthy; every service of the default selection is present.
assert_stack_healthy() {
  step "Wait for every service to be healthy"
  local deadline=$((SECONDS + timeout_seconds)) container line service state health present pending
  while true; do
    pending=""
    present=" "
    while IFS= read -r container; do
      [[ -n "$container" ]] || continue
      line="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.service"}} {{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container")"
      read -r service state health <<<"$line"
      present+="$service "
      if [[ "$state" != "running" || (-n "$health" && "$health" != "healthy") ]]; then
        pending+=" $service(${state}${health:+/$health})"
      fi
    done < <(project_containers)
    for service in "${expected_services[@]}"; do
      [[ "$present" == *" $service "* ]] || pending+=" $service(missing)"
    done
    [[ -n "$pending" ]] || return 0
    if ((SECONDS >= deadline)); then
      fail "not healthy after ${timeout_seconds}s:$pending"
    fi
    sleep 5
  done
}

# The operations agent mounts only what its manifest declares, infra/docker
# and directories below it: no mount's source or destination is the checkout.
assert_agent_without_checkout() {
  step "Check the operations agent does not mount the checkout"
  local physical containers container source destination path
  physical="$(cd "$root" && pwd -P)"
  containers="$(docker ps --quiet --filter "label=com.docker.compose.project=$project" \
    --filter "label=com.docker.compose.service=ops-agent")"
  [[ -n "$containers" ]] || fail "no ops-agent container is running"
  while IFS= read -r container; do
    [[ -n "$container" ]] || continue
    while IFS=$'\t' read -r source destination; do
      [[ -n "$source$destination" ]] || continue
      for path in "$source" "$destination"; do
        if [[ "$path" == "$root" || "$path" == "$physical" ]]; then
          fail "the ops-agent container mounts the checkout: $source -> $destination"
        fi
      done
    done < <(docker inspect --format '{{range .Mounts}}{{.Source}}{{"\t"}}{{.Destination}}{{"\n"}}{{end}}' "$container")
  done <<<"$containers"
}

start_infrastructure() {
  step "Start the infrastructure services"
  logged start openmapx services start postgis redis traefik app-api data-manager ||
    fail "services start failed"
  logged status openmapx services status || fail "services status failed"
  assert_data_manager_status
}

case_install() {
  step "Case: fresh install"
  reset_project
  configure_environment
  render_stack
  start_infrastructure
  assert_check_clean
  step "Bring up the full stack"
  logged up openmapx compose up || fail "compose up failed"
  assert_stack_healthy
  assert_agent_without_checkout
  assert_check_clean
}

# A start that fails on a taken port must leave the project able to start once
# the port is free.
case_retry_after_failed_start() {
  step "Case: start fails on a taken port, then succeeds on retry"
  reset_project
  configure_environment
  render_stack
  step "Occupy port 80"
  docker run --detach --name "$blocker" --publish 80:80 --entrypoint tail \
    "$(manifest_image redis)" -f /dev/null >/dev/null
  step "Start while port 80 is taken"
  if logged blocked openmapx services start postgis redis traefik app-api data-manager; then
    fail "services start succeeded although port 80 was taken"
  fi
  grep -qiE 'already allocated|address already in use' "$work/blocked.log" ||
    fail "the start failed, but not because port 80 was taken"
  step "Free port 80 and retry"
  docker rm --force "$blocker" >/dev/null
  start_infrastructure
  assert_check_clean
}

# Nothing is cleaned up until the preconditions pass: they exist to keep this
# script away from a deployment it did not create, so a refusal must not run
# the cleanup that deletes one.
main() {
  step "Check preconditions"
  local tool
  for tool in docker node openssl pnpm curl awk; do
    command -v "$tool" >/dev/null || fail "$tool is required"
  done
  docker info >/dev/null 2>&1 || fail "the Docker daemon is not reachable"
  [[ ! -e "$env_file" ]] || fail "$env_file already exists; this check only runs on a fresh checkout"
  [[ -z "$(project_containers)" ]] || fail "the compose project '$project' already has containers"
  [[ -z "$(docker volume ls --quiet --filter "label=com.docker.compose.project=$project")" ]] ||
    fail "the compose project '$project' already has volumes; the check would delete them"

  work="$(mktemp -d)"
  trap on_exit EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  build_images
  pull_third_party_images
  case_install
  case_retry_after_failed_start

  step "Done"
  echo "Install smoke check passed"
}

# Sourcing the file defines the functions without running anything.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
