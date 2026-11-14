#!/bin/sh
# The one place cargo is run from. Every other file in the repository (workflows, hooks, package scripts, other scripts) calls `sh scripts/rust.sh <check>` and never cargo itself, so there is one list of invocations to review, each against the committed lock file and the toolchain rust/rust-toolchain.toml pins, which applies because every check runs from rust/. scripts/check-cargo-entry.sh fails when anything else runs cargo directly; indirect forms such as sh -c or xargs are not detected (ExaDev/trilean issue 136).
#
# Usage: rust.sh <check> [arguments]. Checks:
#   fmt                         formatting
#   clippy                      lints, warnings denied
#   test                        the tests
#   deny                        cargo-deny's bans, licences and sources, which change only with the change under review
#   advisories                  cargo-deny's advisories, which change with the advisory database
#   deny-bans <manifest> <config>        the bans check of another workspace with its own configuration (absolute paths)
#   deny-bans-json <manifest> <config>   the same, with cargo-deny's diagnostics as JSON lines on stderr
#   compile-fail                every file in rust/tests/compile-fail/cases must fail to compile with the text its `// expect:` line gives
#   metadata [manifest]         the workspace members as cargo metadata JSON on stdout
#   metadata-resolved           the workspace and its resolved dependency graph as cargo metadata JSON on stdout
#   xtask <arguments>           the repository's build tasks, for example `xtask npm trilean-regex`, which builds that npm package from its binding crate
#   install-wasm-bindgen        installs the wasm-bindgen command line tool at the version Cargo.lock pins, unless that version is already installed
set -eu

cd "$(dirname "$0")/../rust"

# The pinned toolchain is installed on first use, since rustup does not install it by itself. Its output goes to stderr so stdout stays clean for metadata.
rustup show active-toolchain >/dev/null 2>&1 || rustup toolchain install >&2

check=${1:-}
[ "$#" -eq 0 ] || shift
case "$check" in
  fmt) cargo fmt --check ;;
  clippy) cargo clippy --locked --all-targets --all-features -- -D warnings ;;
  test) cargo test --locked --all-targets --all-features ;;
  deny) cargo deny --locked check bans licenses sources ;;
  advisories) cargo deny --locked check advisories ;;
  deny-boundaries) cargo deny --locked --config deny-boundaries.toml check bans ;;
  deny-bans) cargo deny --locked --manifest-path "$1" --config "$2" check bans ;;
  deny-bans-json) cargo deny --locked --manifest-path "$1" --config "$2" --format json -L info check bans ;;
  compile-fail)
    # One build per case, with the case's name as a cfg flag on the final crate only, so the dependencies are built once. A case that compiles, or fails with other text, fails the check.
    failures=0
    for case in tests/compile-fail/cases/*.rs; do
      name=$(basename "$case" .rs)
      expected=$(sed -n 's|^// expect: ||p' "$case")
      if [ -z "$expected" ]; then
        echo "FAIL $name has no // expect: line" >&2
        failures=$((failures + 1))
      elif output=$(cargo rustc --locked -p json-shape-compile-fail --lib -- --cfg "compile_fail=\"$name\"" 2>&1); then
        echo "FAIL $name compiled, and must be refused" >&2
        failures=$((failures + 1))
      elif printf '%s\n' "$output" | grep -qF -- "$expected"; then
        echo "ok   $name is refused"
      else
        echo "FAIL $name failed without the expected text: $expected" >&2
        printf '%s\n' "$output" >&2
        failures=$((failures + 1))
      fi
    done
    [ "$failures" -eq 0 ]
    ;;
  metadata)
    if [ "$#" -gt 0 ]; then
      cargo metadata --locked --no-deps --format-version 1 --manifest-path "$1"
    else
      cargo metadata --locked --no-deps --format-version 1
    fi
    ;;
  metadata-resolved) cargo metadata --locked --format-version 1 ;;
  xtask) cargo run --locked --package xtask -- "$@" ;;
  install-wasm-bindgen)
    version=$(awk '/^name = "wasm-bindgen"$/ { getline; gsub(/version = |"/, ""); print; exit }' Cargo.lock)
    [ -n "$version" ] || { echo "Cargo.lock does not pin wasm-bindgen" >&2; exit 1; }
    if [ "$(wasm-bindgen --version 2>/dev/null)" != "wasm-bindgen $version" ]; then
      cargo install --locked --version "$version" wasm-bindgen-cli
    fi
    ;;
  *)
    echo "usage: rust.sh fmt|clippy|test|compile-fail|deny|advisories|deny-bans|deny-bans-json|metadata [arguments]" >&2
    exit 2
    ;;
esac
