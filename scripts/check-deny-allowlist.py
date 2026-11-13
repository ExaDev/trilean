#!/usr/bin/env python3
"""Fails when rust/deny.toml allows a crate that cargo-deny does not find in the dependency graph.

cargo-deny fails a crate that is missing from the allowlist, but reports an allowlisted crate that nothing uses only as a note: it has no option to make that an error, so the allowlist could grow wider than the graph without any review of the file. This closes the other direction, and takes the graph from the tool that enforces it: the crates cargo-deny itself reports as explicitly allowed (every platform and every feature, as `[graph]` in deny.toml says, and cfg edges evaluated the way cargo-deny evaluates them). A second definition of the graph, from `cargo tree` or `cargo metadata`, disagrees with the enforcing one for any platform-gated crate, and no deny.toml could satisfy both.

Usage: check-deny-allowlist.py [--rust-dir DIR] [--config FILE]. It runs cargo-deny with the pinned toolchain against the committed Cargo.lock, and needs Python 3.11 for tomllib.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import tomllib
from pathlib import Path

DEFAULT_RUST = Path(__file__).resolve().parent.parent / "rust"
CRATE = re.compile(r"crate '([^' ]+) = ")


def allowed_names(config: Path) -> set[str]:
    names: set[str] = set()
    for entry in tomllib.loads(config.read_text())["bans"]["allow"]:
        names.add(entry if isinstance(entry, str) else entry["crate"])
    return names


def diagnostics(rust: Path, config: Path) -> list[dict[str, object]]:
    """The bans diagnostics cargo-deny prints, as JSON lines on stderr, whatever its exit status."""
    result = subprocess.run(
        ["cargo", "deny", "--locked", "--manifest-path", str(rust / "Cargo.toml"), "--config", str(config), "--format", "json", "-L", "info", "check", "bans"],
        check=False,
        capture_output=True,
        text=True,
    )
    found: list[dict[str, object]] = []
    for line in result.stderr.splitlines():
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            continue
        if record.get("type") == "diagnostic":
            found.append(record["fields"])
    if not found:
        raise SystemExit(f"cargo deny reported no diagnostics for {config}: {result.stderr[:500]}")
    return found


def crates_with_code(found: list[dict[str, object]], code: str) -> set[str]:
    """The names of the crates the diagnostics with this code are about (`crate 'name = 1.2.3' is ...`)."""
    names: set[str] = set()
    for record in found:
        match = CRATE.match(str(record.get("message", "")))
        if record.get("code") == code and match:
            names.add(match.group(1))
    return names


def main(arguments: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--rust-dir", type=Path, default=DEFAULT_RUST)
    parser.add_argument("--config", type=Path)
    args = parser.parse_args(arguments)
    config = args.config or args.rust_dir / "deny.toml"
    found = diagnostics(args.rust_dir, config)
    in_graph = crates_with_code(found, "allowed") | crates_with_code(found, "not-allowed")
    status = 0
    for name in sorted(allowed_names(config) - in_graph):
        print(f"{config.name} allows {name}, which cargo-deny does not find in the dependency graph")
        status = 1
    for name in sorted(crates_with_code(found, "not-allowed")):
        print(f"{name} is in the dependency graph and is not allowed by {config.name}")
        status = 1
    return status


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
