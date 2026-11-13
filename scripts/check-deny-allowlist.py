#!/usr/bin/env python3
"""Fails when rust/deny.toml allows a crate that is not in the workspace's dependency graph.

cargo-deny fails a crate that is missing from the allowlist, but reports an allowlisted crate that nothing uses only as a silent no-op (it has no option to make that an error), so the allowlist could grow wider than the graph without any review of the file. This script closes the other direction: the names under [bans] allow and the names in the graph (every feature, every kind of dependency) must be the same set.

Usage: check-deny-allowlist.py. It runs `cargo tree` in rust/, so it uses the pinned toolchain and the committed Cargo.lock.
"""
from __future__ import annotations

import subprocess
import sys
import tomllib
from pathlib import Path

RUST = Path(__file__).resolve().parent.parent / "rust"


def allowed_names() -> set[str]:
    config = tomllib.loads((RUST / "deny.toml").read_text())
    names: set[str] = set()
    for entry in config["bans"]["allow"]:
        names.add(entry if isinstance(entry, str) else entry["crate"])
    return names


def graph_names() -> set[str]:
    tree = subprocess.run(
        ["cargo", "tree", "--locked", "--workspace", "--all-features", "--edges", "all", "--prefix", "none", "--format", "{p}"],
        cwd=RUST,
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    return {line.split()[0] for line in tree.splitlines() if line.strip()}


def main() -> int:
    allowed, graph = allowed_names(), graph_names()
    status = 0
    for name in sorted(allowed - graph):
        print(f"deny.toml allows {name}, which is not in the dependency graph")
        status = 1
    for name in sorted(graph - allowed):
        print(f"{name} is in the dependency graph and is not allowed by deny.toml")
        status = 1
    return status


if __name__ == "__main__":
    sys.exit(main())
