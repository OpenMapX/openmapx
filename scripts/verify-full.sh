#!/bin/sh
set -e

# Full verification can be invoked from a hook or linked worktree. Temporary
# repository tests must not inherit the calling repository's Git metadata.
unset \
  GIT_ALTERNATE_OBJECT_DIRECTORIES \
  GIT_COMMON_DIR \
  GIT_CONFIG \
  GIT_CONFIG_COUNT \
  GIT_CONFIG_PARAMETERS \
  GIT_DIR \
  GIT_GRAFT_FILE \
  GIT_IMPLICIT_WORK_TREE \
  GIT_INDEX_FILE \
  GIT_NO_REPLACE_OBJECTS \
  GIT_OBJECT_DIRECTORY \
  GIT_PREFIX \
  GIT_REPLACE_REF_BASE \
  GIT_SHALLOW_FILE \
  GIT_WORK_TREE

# Share the existing lock with older OpenMapX/OpenConditions worktrees.
# Ordinary pushes never wait here; only explicitly requested heavy work does.
gates='pnpm lint && pnpm check-types && pnpm check:policy && pnpm check-openapi && pnpm test --maxWorkers=50%'
lock="${TMPDIR:-/tmp}/pre-push.lock"
started=$(date +%s)
echo "Full verification: waiting up to 60s for $lock"
# Deliberately expanded by sh -c only after the lock is acquired.
# shellcheck disable=SC2016
locked='echo "Full verification: lock acquired after $(($(date +%s) - $1))s"; eval "$2"'
if command -v flock >/dev/null 2>&1; then
  flock -w 60 "$lock" sh -c "$locked" verify-full "$started" "$gates"
elif [ -x /usr/bin/lockf ]; then
  /usr/bin/lockf -k -t 60 "$lock" sh -c "$locked" verify-full "$started" "$gates"
else
  echo "No flock/lockf available; avoid concurrent full verification runs." >&2
  sh -c "$gates"
fi
