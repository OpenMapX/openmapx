#!/bin/sh

set -eu

load_secret() {
  name=$1
  case "$name" in
    DATABASE_PASSWORD | SECRET_KEY_BASE | OIDC_CLIENT_SECRET) ;;
    *)
      printf 'Refusing undeclared Dawarich secret name: %s\n' "$name" >&2
      exit 1
      ;;
  esac

  secret_file="/run/secrets/$name"
  if [ ! -r "$secret_file" ]; then
    printf 'Required Dawarich secret file is missing or unreadable: %s\n' "$name" >&2
    exit 1
  fi

  value=$(command cat "$secret_file")
  if [ -z "$value" ]; then
    printf 'Required Dawarich secret file is empty: %s\n' "$name" >&2
    exit 1
  fi

  export "$name=$value"
  unset value secret_file
}

load_secret DATABASE_PASSWORD
load_secret SECRET_KEY_BASE
load_secret OIDC_CLIENT_SECRET

exec /usr/local/bin/sidekiq-entrypoint.sh "$@"
