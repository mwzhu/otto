#!/usr/bin/env bash
# Deploy an Otto LiveKit voice worker (director or operator) to LiveKit Cloud Agents.
#
# Why this wrapper exists:
#   LiveKit Cloud's source build pins BOTH the build context and the Dockerfile to
#   the working directory, and "Bring Your Own Container" (lk agent --image) is
#   Enterprise-only. Our agent Dockerfiles need repo-root context (they COPY
#   prompts/, schemas/, probes/, agents/realtime_core), so we deploy from the repo
#   root and stage the chosen agent's Dockerfile as ./Dockerfile for the build.
#   The root .dockerignore keeps the upload lean; ./Dockerfile is git-ignored and
#   removed on exit.
#
# Prereqs (one-time):
#   brew install livekit-cli
#   lk project add otto --url https://otto-gcbsujid.livekit.cloud \
#     --api-key "$LIVEKIT_API_KEY" --api-secret "$LIVEKIT_API_SECRET" --default
#
# Usage:
#   scripts/deploy-livekit-agent.sh <director|operator> [extra lk agent flags...]
#
# Env overrides: LK_PROJECT (default otto), LK_REGION (default us-east, used only
# on first-time create).
set -euo pipefail

ROLE="${1:-}"
shift || true
case "$ROLE" in
  director|operator) ;;
  *) echo "usage: $0 <director|operator> [extra lk agent deploy flags]" >&2; exit 2 ;;
esac

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

AGENT_DOCKERFILE="agents/$ROLE/Dockerfile"
CONFIG="livekit.$ROLE.toml"
SECRETS="agents/$ROLE/.env.cloud"

for f in "$AGENT_DOCKERFILE" "$SECRETS"; do
  [ -f "$f" ] || { echo "missing required file: $f" >&2; exit 1; }
done

# Stage the agent Dockerfile at the repo root for the duration of the build.
cleanup() { rm -f "$REPO_ROOT/Dockerfile"; }
trap cleanup EXIT
cp "$AGENT_DOCKERFILE" "$REPO_ROOT/Dockerfile"

# First deploy (no livekit.$ROLE.toml yet) uses `create` and needs a region;
# subsequent deploys ship a new version with `deploy`.
extra=()
if [ -f "$CONFIG" ]; then
  subcmd=deploy
else
  subcmd=create
  extra+=(--region "${LK_REGION:-us-east}")
fi

echo ">> lk agent $subcmd $ROLE (project=${LK_PROJECT:-otto}, config=$CONFIG)"
lk agent "$subcmd" \
  --project "${LK_PROJECT:-otto}" \
  --config "$CONFIG" \
  --secrets-file "$SECRETS" \
  --skip-sdk-check \
  --yes \
  ${extra[@]+"${extra[@]}"} "$@" \
  "$REPO_ROOT"
