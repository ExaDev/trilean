#!/usr/bin/env python3
"""Fails when a crate in the Rust workspace does not take its settings from the workspace.

Cargo applies `[workspace.lints]` and `[workspace.package]` to a member only when the member opts in, so a crate added without the stanzas silently escapes `unsafe_code = "deny"` and the shared edition, rust-version and licence. This checks every member listed in rust/Cargo.toml (globs expanded, `exclude` honoured) for `[lints] workspace = true` and for `edition`, `rust-version` and `license` inherited with `workspace = true`, and checks that the workspace itself sets each of them.

Usage: check-workspace-members.py [rust-directory]. It reads TOML only, so it needs no toolchain.
"""
from __future__ import annotations

import sys
import tomllib
from pathlib import Path

INHERITED = ("edition", "rust-version", "license")


def member_directories(root: Path, workspace: dict[str, object]) -> list[Path]:
    members = workspace.get("members", [])
    excluded = {(root / pattern).resolve() for pattern in workspace.get("exclude", [])}  # type: ignore[union-attr]
    directories: list[Path] = []
    for pattern in members:  # type: ignore[union-attr]
        for match in sorted(root.glob(pattern)):
            if match.is_dir() and match.resolve() not in excluded:
                directories.append(match)
    return directories


def problems_in(root: Path) -> list[str]:
    manifest = tomllib.loads((root / "Cargo.toml").read_text())
    workspace = manifest.get("workspace")
    if workspace is None:
        return [f"{root / 'Cargo.toml'} has no [workspace]"]
    problems: list[str] = []
    shared = workspace.get("package", {})
    for key in INHERITED:
        if key not in shared:
            problems.append(f"[workspace.package] does not set {key}")
    if "lints" not in workspace:
        problems.append("[workspace.lints] is not set")
    directories = member_directories(root, workspace)
    if not directories:
        problems.append("the workspace has no member crates")
    for directory in directories:
        name = directory.relative_to(root)
        crate = tomllib.loads((directory / "Cargo.toml").read_text())
        if crate.get("lints") != {"workspace": True}:
            problems.append(f"{name}: [lints] workspace = true is missing")
        package = crate.get("package", {})
        for key in INHERITED:
            if package.get(key) != {"workspace": True}:
                problems.append(f"{name}: {key} is not inherited with {key}.workspace = true")
    return problems


def main() -> int:
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent / "rust"
    problems = problems_in(root)
    for problem in problems:
        print(problem)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
