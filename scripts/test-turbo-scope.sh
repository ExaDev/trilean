#!/bin/sh
# Tests scripts/turbo-scope.sh over a throwaway repository: a range touching only the corpus, only rust/, only a package, only documentation and nothing at all, and a base that is not there.
set -eu

for variable in $(git rev-parse --local-env-vars); do
  unset "$variable"
done

here=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
failures=0

mkdir -p "$work/repo/scripts" "$work/repo/conformance" "$work/repo/rust" "$work/repo/packages/a" "$work/repo/docs"
cp "$here/scripts/turbo-scope.sh" "$here/scripts/rust-paths.sh" "$work/repo/scripts/"
cd "$work/repo"
git init -q -b main
git config user.email test@example.com
git config user.name test
for file in conformance/manifest.json rust/Cargo.toml packages/a/index.ts docs/a.md; do echo a > "$file"; done
git add -A && git commit -q -m base
base=$(git rev-parse HEAD)

change() {
  # change <branch> <file>: a commit on a branch from the base touching one file
  git checkout -q -b "$1" "$base"
  mkdir -p "$(dirname "$2")"
  echo b >> "$2"
  git add -A && git commit -q -m "$1"
}

expect() {
  # expect <name> <expected flags> <head> [base]
  out=$(sh scripts/turbo-scope.sh "${4:-$base}" "$3" 2>&1) && status=0 || status=$?
  if [ "$status" -eq 0 ] && [ "$out" = "$2" ]; then echo "ok   $1"; else echo "FAIL $1: expected '$2', got '$out' (status $status)"; failures=$((failures + 1)); fi
}

change corpus conformance/manifest.json
change rust rust/Cargo.toml
change package packages/a/index.ts
change docs docs/a.md
change script scripts/other.sh
change new-corpus-file conformance/trilean-regex/parse/new.json

expect "a change to the corpus runs everything" "" corpus
expect "a new corpus file runs everything" "" new-corpus-file
expect "a change to rust/ runs everything" "" rust
expect "a change to one package runs the affected packages" "--affected" package
expect "a change to documentation runs the affected packages" "--affected" docs
expect "a change to a script runs the affected packages" "--affected" script
expect "no change runs the affected packages" "--affected" "$base"
out=$(sh scripts/turbo-scope.sh 1111111111111111111111111111111111111111 package 2>&1) && status=0 || status=$?
if [ "$status" -ne 0 ] && printf '%s' "$out" | grep -q "not in this checkout"; then echo "ok   a base that is not here fails loudly"; else echo "FAIL a missing base: status $status, '$out'"; failures=$((failures + 1)); fi
out=$(sh scripts/turbo-scope.sh "" package 2>&1) && status=0 || status=$?
if [ "$status" -ne 0 ]; then echo "ok   an empty base fails loudly"; else echo "FAIL an empty base: '$out'"; failures=$((failures + 1)); fi
exit "$failures"
