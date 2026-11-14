#!/bin/sh
# Prints the flags CI passes to turbo for a pull request: `--affected` to run only the packages the pull request touches and what depends on them, or nothing to run every package. The Rust workspace and the conformance corpus belong to no TypeScript package, so a pull request that changes either selects no package under `--affected`; those paths (scripts/rust-paths.sh --full-matrix, the one definition) force the full matrix.
#
# Usage: turbo-scope.sh <base sha> [head]. The base is the pull request's base commit from the event. It must be a commit this checkout has: the choice is made from the diff against it, and a missing base is an error, never a quiet fall back to `--affected`, which would run less than the change needs.
set -eu

cd "$(dirname "$0")/.."

base=${1:-}
head=${2:-HEAD}
if [ -z "$base" ] || ! git cat-file -e "$base^{commit}" 2>/dev/null; then
  echo "turbo-scope: the pull request's base commit ${base:-"(empty)"} is not in this checkout, so the changed paths cannot be read (checkout with fetch-depth: 0)" >&2
  exit 1
fi

if git diff --name-only "$base" "$head" -- | sh scripts/rust-paths.sh --full-matrix; then
  echo ""
else
  echo "--affected"
fi
