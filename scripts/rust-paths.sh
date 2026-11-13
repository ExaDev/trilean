#!/bin/sh
# Reads file paths on stdin, one per line, and exits 0 when any of them is something the Rust checks cover: the Rust workspace and its toolchain pin, the conformance corpus the native loader reads, the scripts that run or guard the Rust checks, and the workflows that run them. Exits 1 when none is.
set -eu

grep -Eq '^(rust/|conformance/|scripts/|\.github/workflows/(ci|advisories)\.yml$|\.husky/pre-push$)'
