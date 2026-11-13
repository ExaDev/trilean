#!/bin/sh
# Fails on any cargo command that can resolve dependencies without --locked, and on any cargo command that names a toolchain, in the files that run cargo for this repository: CI workflows, the git hooks, shell scripts and package manifests. The committed Cargo.lock is the graph that was reviewed, so a run that may rewrite it can pass or fail on crates nobody reviewed; and the toolchain is whatever rust/rust-toolchain.toml pins, in that one place.
#
# Usage: check-cargo-locked.sh [file...]. With no file it checks every file the repository runs cargo from.
set -eu

cd "$(dirname "$0")/.."

if [ "$#" -eq 0 ]; then
  set -- .github/workflows/*.yml .husky/pre-push scripts/rust-checks.sh package.json packages/*/package.json
fi

# Subcommands that resolve the dependency graph. fmt and install do not, and are left alone.
resolving='(build|b|check|c|clippy|test|t|run|r|doc|bench|deny|metadata|tree|fetch)'
status=0
for file in "$@"; do
  [ -f "$file" ] || continue
  # Comment lines (shell or YAML) describe commands rather than run them.
  unlocked=$(grep -nE "(^|[^[:alnum:]_-])cargo[[:space:]]+${resolving}([[:space:]]|\$)" "$file" | grep -vE '^[0-9]+:[[:space:]]*#' | grep -v -- '--locked' || true)
  if [ -n "$unlocked" ]; then
    echo "$file: cargo without --locked:"
    echo "$unlocked"
    status=1
  fi
  pinned=$(grep -nE "(^|[^[:alnum:]_-])cargo[[:space:]]+\\+" "$file" | grep -vE '^[0-9]+:[[:space:]]*#' || true)
  if [ -n "$pinned" ]; then
    echo "$file: cargo names a toolchain instead of using rust/rust-toolchain.toml:"
    echo "$pinned"
    status=1
  fi
done
exit "$status"
