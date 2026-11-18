#!/usr/bin/env python3
"""Keeps the version of every crate published to crates.io equal to the version of the npm package it is released with, and lists what a publish has to upload.

A workspace crate is published when its manifest does not say `publish = false`. Each published crate names, in `[package.metadata.trilean-release] npm-package`, the package under `packages/` whose wasm module it is built into, and it takes that package's version: the release orchestrator decides the package's version from its commits (its `packageSources` list the crates), and the `prepare` step of scripts/semantic-release-crate-versions.mjs writes the same version into the crates with `set`, so the release commit holds both. A crate published with no package to follow would have no release to version it, so it is refused.

Usage:
  crate-versions.py check                  fails when a published crate's version, or the version its siblings require it at, differs from its package's crate-versions.py set <package> <version>  writes the version into every crate released with the package, into the requirement `[workspace.dependencies]` gives it and into Cargo.lock crate-versions.py published              the published crates, one `-p <crate>` argument pair per line, for `rust.sh publish-dry-run` and `rust.sh package-list` crate-versions.py unpublished            the same arguments for each published crate whose version crates.io does not hold yet; fails naming every crate crates.io has never held, since trusted publishing cannot make a crate's first release

It needs only the standard library (Python 3.9 or later); `check`, `set` and `published` need the Rust toolchain too, for cargo's metadata.
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

ROOT = Path(__file__).resolve().parent.parent
RUST = ROOT / "rust"
METADATA_KEY = "trilean-release"
# The sparse index serves one file per crate, listing every version ever published, without the API's rate limits.
INDEX = "https://index.crates.io"
USER_AGENT = "trilean-release (https://github.com/ExaDev/trilean)"


@dataclass(frozen=True)
class Crate:
    """A workspace crate published to crates.io, and the npm package it is released with."""

    name: str
    version: str
    manifest: Path
    package: str | None
    # The requirement each workspace sibling's dependency names it at, by the depending crate's name.
    required_at: tuple[tuple[str, str], ...]


def read_metadata() -> dict[str, object]:
    """cargo's metadata for the workspace members, through scripts/rust.sh, the one place cargo runs."""
    output = subprocess.run(["sh", str(ROOT / "scripts" / "rust.sh"), "metadata"], check=True, capture_output=True, text=True).stdout
    loaded: object = json.loads(output)
    if not isinstance(loaded, dict):
        raise SystemExit("cargo metadata did not print an object")
    return loaded


def published_crates(metadata: dict[str, object]) -> list[Crate]:
    """Every workspace crate whose manifest lets it be published, in the order cargo lists them."""
    packages = metadata.get("packages")
    if not isinstance(packages, list):
        raise SystemExit("cargo metadata has no packages list")
    entries = [entry for entry in packages if isinstance(entry, dict)]
    # `publish = false` is reported as an empty list of registries; an absent setting, any registry, is null.
    publishable = {str(entry["name"]) for entry in entries if entry.get("publish") != []}
    crates: list[Crate] = []
    for entry in entries:
        name = str(entry["name"])
        if name not in publishable:
            continue
        settings = entry.get("metadata")
        release = settings.get(METADATA_KEY) if isinstance(settings, dict) else None
        package = release.get("npm-package") if isinstance(release, dict) else None
        required_at = []
        for other in entries:
            for dependency in other.get("dependencies", []):
                if isinstance(dependency, dict) and dependency.get("name") == name and dependency.get("path") is not None:
                    required_at.append((str(other["name"]), str(dependency.get("req"))))
        crates.append(Crate(name, str(entry["version"]), Path(str(entry["manifest_path"])), package if isinstance(package, str) else None, tuple(sorted(set(required_at)))))
    return crates


def package_version(package: str) -> str | None:
    """The version in packages/<package>/package.json, or None when there is no such package."""
    manifest = ROOT / "packages" / package / "package.json"
    if not manifest.is_file():
        return None
    loaded: object = json.loads(manifest.read_text())
    version = loaded.get("version") if isinstance(loaded, dict) else None
    return version if isinstance(version, str) else None


def problems_in(crates: list[Crate], versions: Callable[[str], str | None]) -> list[str]:
    """What disagrees between each published crate, its package's version and the requirement its siblings give it."""
    problems: list[str] = []
    if not crates:
        problems.append("the workspace publishes no crate")
    for crate in crates:
        if crate.package is None:
            problems.append(f"{crate.name}: published, but [package.metadata.{METADATA_KEY}] names no npm-package to take its version from (set publish = false, or name the package)")
            continue
        expected = versions(crate.package)
        if expected is None:
            problems.append(f"{crate.name}: npm-package {crate.package!r} is not a package under packages/")
            continue
        if crate.version != expected:
            problems.append(f"{crate.name}: version {crate.version}, but {crate.package} is {expected} (scripts/crate-versions.py set {crate.package} {expected})")
        for dependant, requirement in crate.required_at:
            if requirement != f"^{expected}":
                problems.append(f"{dependant} requires {crate.name} at {requirement}, not ^{expected}")
    return problems


def set_version_in_manifest(text: str, version: str) -> str:
    """The manifest with the `version` of its [package] table replaced, which must be written as a literal."""
    replaced, count = re.subn(r'(\A|\n)(\[package\]\n(?:(?!\[)[^\n]*\n)*?)version = "[^"]*"\n', rf'\g<1>\g<2>version = "{version}"\n', text, count=1)
    if count != 1:
        raise SystemExit('a published crate\'s [package] table must set version = "..." literally')
    return replaced


def set_requirement(text: str, name: str, version: str) -> str:
    """The workspace manifest with the version of `name` in [workspace.dependencies] replaced."""
    replaced, count = re.subn(rf'(\n{re.escape(name)} = \{{[^}}\n]*version = ")[^"]*(")', rf"\g<1>{version}\g<2>", text, count=1)
    if count != 1:
        raise SystemExit(f'[workspace.dependencies] must name {name} with path and version = "..."')
    return replaced


def set_locked_version(text: str, name: str, version: str) -> str:
    """Cargo.lock with the version of the workspace crate `name` replaced. A workspace crate's entry has no source line."""
    replaced, count = re.subn(rf'(\[\[package\]\]\nname = "{re.escape(name)}"\nversion = ")[^"]*("\n(?!source))', rf"\g<1>{version}\g<2>", text, count=1)
    if count != 1:
        raise SystemExit(f"Cargo.lock has no single workspace entry for {name}")
    return replaced


def set_versions(crates: list[Crate], package: str, version: str) -> list[str]:
    """Writes `version` into every crate released with `package`, and returns their names. A package that ships no crate gets none."""
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?", version):
        raise SystemExit(f"{version!r} is not a release version")
    owned = [crate for crate in crates if crate.package == package]
    workspace = RUST / "Cargo.toml"
    lock = RUST / "Cargo.lock"
    workspace_text = workspace.read_text()
    lock_text = lock.read_text()
    for crate in owned:
        crate.manifest.write_text(set_version_in_manifest(crate.manifest.read_text(), version))
        if crate.required_at:
            workspace_text = set_requirement(workspace_text, crate.name, version)
        lock_text = set_locked_version(lock_text, crate.name, version)
    workspace.write_text(workspace_text)
    lock.write_text(lock_text)
    return [crate.name for crate in owned]


def index_path(name: str) -> str:
    """The path of a crate's file in the sparse index, which shards by the name's length and first letters."""
    lowered = name.lower()
    if len(lowered) <= 2:
        return f"{len(lowered)}/{lowered}"
    if len(lowered) == 3:
        return f"3/{lowered[0]}/{lowered}"
    return f"{lowered[:2]}/{lowered[2:4]}/{lowered}"


def indexed_versions(name: str) -> set[str] | None:
    """Every version crates.io holds of the crate, or None when it has never held the crate."""
    request = urllib.request.Request(f"{INDEX}/{index_path(name)}", headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            body = response.read().decode()
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return None
        raise
    return {str(json.loads(line)["vers"]) for line in body.splitlines() if line.strip()}


def unpublished(crates: list[Crate], lookup: Callable[[str], set[str] | None]) -> tuple[list[Crate], list[Crate]]:
    """The crates whose version crates.io lacks, and those it has never held at all."""
    missing: list[Crate] = []
    never: list[Crate] = []
    for crate in crates:
        held = lookup(crate.name)
        if held is None:
            never.append(crate)
        elif crate.version not in held:
            missing.append(crate)
    return missing, never


def arguments(crates: list[Crate]) -> str:
    return "".join(f"-p\n{crate.name}\n" for crate in crates)


def main(argv: list[str]) -> int:
    command = argv[1] if len(argv) > 1 else ""
    if command == "check" and len(argv) == 2:
        problems = problems_in(published_crates(read_metadata()), package_version)
        for problem in problems:
            print(problem, file=sys.stderr)
        return 1 if problems else 0
    if command == "set" and len(argv) == 4:
        names = set_versions(published_crates(read_metadata()), argv[2], argv[3])
        print(f"{argv[2]} {argv[3]}: {', '.join(names) if names else 'no crate is released with this package'}")
        return 0
    if command == "published" and len(argv) == 2:
        sys.stdout.write(arguments(published_crates(read_metadata())))
        return 0
    if command == "unpublished" and len(argv) == 2:
        missing, never = unpublished(published_crates(read_metadata()), indexed_versions)
        if never:
            names = " ".join(crate.name for crate in never)
            print(f"crates.io has never held {names}. Trusted publishing configures a crate that exists, so each one's first release is published with an API token, and its trusted publisher registered, before this job can publish it.", file=sys.stderr)
            return 1
        sys.stdout.write(arguments(missing))
        return 0
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
