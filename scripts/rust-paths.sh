#!/bin/sh
# The one definition of which changed paths matter to the Rust side, for the pre-push hook and for CI's choice of how much of the TypeScript matrix to run. Reads file paths on stdin, one per line, and exits 0 when any of them matches the list asked for, 1 when none does.
#
#   rust-paths.sh            what the Rust checks cover: the Rust workspace and its toolchain pin, the conformance corpus the native loader reads, the scripts that run or guard the checks, and the workflows and hook that run them.
#   rust-paths.sh --full-matrix   what forces every TypeScript package's tests to run on a pull request: the Rust workspace and the corpus, which every package that is, or becomes, a build of the Rust crates is tested against, and which belong to no package that `--affected` could select.
set -eu

# The paths the Rust workspace and the corpus occupy: shared by both lists, so they cannot drift apart.
shared='rust/|conformance/'

case "${1:-}" in
  --full-matrix) grep -Eq "^($shared)" ;;
  '') grep -Eq "^($shared|scripts/|\\.github/workflows/(ci|advisories)\\.yml\$|\\.husky/pre-push\$)" ;;
  *) echo "usage: rust-paths.sh [--full-matrix]" >&2; exit 2 ;;
esac
