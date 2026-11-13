#!/bin/sh
# The Rust checks that run both in CI's rust job and in the pre-push hook, so the two cannot drift: formatting, clippy with warnings denied, and the tests, all against the committed Cargo.lock and the toolchain rust/rust-toolchain.toml pins.
set -eu

cd "$(dirname "$0")/.."

python3 -I scripts/check-cargo-locked.py
python3 -I scripts/check-workspace-members.py
cd rust
cargo fmt --check
cargo clippy --locked --all-targets --all-features -- -D warnings
cargo test --locked --all-targets --all-features
