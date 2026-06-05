#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
initial_env_file=$(mktemp "${TMPDIR:-/tmp}/otto-env-initial.XXXXXX")
loaded_keys_file=$(mktemp "${TMPDIR:-/tmp}/otto-env-keys.XXXXXX")
trap 'rm -f "$initial_env_file" "$loaded_keys_file"' EXIT
env > "$initial_env_file"

load_env_file() {
  env_file=$1
  if [ -f "$env_file" ]; then
    while IFS= read -r key; do
      printf '%s\n' "$key" >> "$loaded_keys_file"
    done < <(
      sed -nE 's/^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=.*/\2/p' "$env_file"
    )
    set -a
    # shellcheck disable=SC1090
    . "$env_file"
    set +a
  fi
}

load_env_file "$repo_root/.env.local"

while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do
  load_env_file "$1"
  shift
done

if [ "$#" -eq 0 ]; then
  echo "usage: scripts/with-env.sh [override.env ...] -- command [args...]" >&2
  exit 64
fi

shift

if [ "$#" -eq 0 ]; then
  echo "usage: scripts/with-env.sh [override.env ...] -- command [args...]" >&2
  exit 64
fi

sorted_keys_file=$(mktemp "${TMPDIR:-/tmp}/otto-env-sorted-keys.XXXXXX")
sort -u "$loaded_keys_file" > "$sorted_keys_file"
while IFS= read -r key; do
  if [ -z "$key" ]; then
    continue
  fi
  initial_line=$(grep -m 1 "^$key=" "$initial_env_file" || true)
  if [ -n "$initial_line" ]; then
    export "$initial_line"
  fi
done < "$sorted_keys_file"
rm -f "$sorted_keys_file"

exec "$@"
