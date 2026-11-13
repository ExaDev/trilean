#!/usr/bin/env python3
"""Fails on any cargo invocation that can resolve dependencies without --locked, and on a CI job that runs cargo without installing the pinned toolchain.

The committed Cargo.lock is the graph that was reviewed, so a run that may rewrite it can pass or fail on crates nobody reviewed, and the toolchain is whatever rust/rust-toolchain.toml pins, in that one place. The rule is an allowlist: every invocation carries --locked, except the subcommands in LOCK_FREE, which never read the lock file. It is checked per invocation, not per line, in workflows, hooks, shell scripts, manifests and Python scripts.

A cargo invocation is a command word `cargo` in shell, YAML or JSON text (after a line start, `&&`, `||`, `;`, `|`, `(` or a backtick, `run:` or `-`), or a list literal that starts with the string "cargo" in Python. Comment lines are skipped, and Python is read only for list literals, since its prose mentions commands without running them.

A job in a workflow that runs cargo, directly or through a script of this repository that does, must contain `rustup toolchain install`.

Usage: check-cargo-locked.py [file...]. With no file it checks every file the repository runs cargo from.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# Subcommands that never read Cargo.lock.
LOCK_FREE = {"fmt"}

SHELL_INVOCATION = re.compile(r"(?:^|&&|\|\||[;|(`]|\brun:|^\s*-)\s*cargo(?![\w-])((?:\s+[^\s&|;`)]+)*)", re.MULTILINE)
PYTHON_INVOCATION = re.compile(r"\[\s*[\"']cargo[\"']\s*((?:,\s*[\"'][^\"']*[\"']\s*)*)\]")


def default_files() -> list[Path]:
    files: list[Path] = sorted((ROOT / ".github" / "workflows").glob("*.yml"))
    files.append(ROOT / ".husky" / "pre-push")
    files += sorted((ROOT / "scripts").glob("*.sh"))
    # test_check_cargo_locked.py holds cargo commands as test data, and runs none.
    files += [path for path in sorted((ROOT / "scripts").glob("*.py")) if path.name != "test_check_cargo_locked.py"]
    files.append(ROOT / "package.json")
    files += sorted((ROOT / "packages").glob("*/package.json"))
    return [path for path in files if path.is_file()]


def strip_shell_comments(text: str) -> str:
    return "\n".join("" if line.lstrip().startswith("#") else line for line in text.splitlines())


def invocations(path: Path, text: str) -> list[list[str]]:
    """The argument lists of every cargo invocation in the file."""
    if path.suffix == ".py":
        return [re.findall(r"[\"']([^\"']*)[\"']", match.group(1)) for match in PYTHON_INVOCATION.finditer(text)]
    return [match.group(1).split() for match in SHELL_INVOCATION.finditer(strip_shell_comments(text))]


def invocation_problem(arguments: list[str]) -> str | None:
    if arguments and arguments[0].startswith("+"):
        return "names a toolchain instead of using rust/rust-toolchain.toml"
    subcommand = next((argument for argument in arguments if not argument.startswith("-")), None)
    if subcommand is None or subcommand in LOCK_FREE or "--locked" in arguments:
        return None
    return "is missing --locked"


def file_problems(path: Path, text: str) -> list[str]:
    problems = []
    for arguments in invocations(path, text):
        problem = invocation_problem(arguments)
        if problem:
            problems.append(f"{path.name}: `cargo {' '.join(arguments)}` {problem}")
    return problems


def runs_cargo(text: str, scripts: dict[str, str]) -> bool:
    """Whether a job's text runs cargo, directly or through a script of this repository that does."""
    if invocations(Path("job.yml"), text):
        return True
    return any(name in text and invocations(Path(name), body) for name, body in scripts.items())


def job_blocks(text: str) -> dict[str, str]:
    """Each job of a workflow with its text, by the two-space indented keys under `jobs:`."""
    after = strip_shell_comments(text).split("\njobs:\n", 1)
    if len(after) != 2:
        return {}
    blocks: dict[str, str] = {}
    name: str | None = None
    for line in after[1].splitlines(keepends=True):
        key = re.match(r"^  ([A-Za-z0-9_-]+):\s*$", line)
        if key:
            name = key.group(1)
            blocks[name] = ""
        elif name is not None:
            blocks[name] += line
    return blocks


def workflow_problems(path: Path, text: str, scripts: dict[str, str]) -> list[str]:
    return [
        f"{path.name}: job {name} runs cargo without `rustup toolchain install`"
        for name, block in job_blocks(text).items()
        if runs_cargo(block, scripts) and "rustup toolchain install" not in block
    ]


def main(arguments: list[str]) -> int:
    files = [Path(argument) for argument in arguments] or default_files()
    scripts = {f"scripts/{path.name}": path.read_text() for path in sorted((ROOT / "scripts").glob("*")) if path.suffix in {".sh", ".py"}}
    problems: list[str] = []
    for path in files:
        text = path.read_text()
        problems += file_problems(path, text)
        if path.parent.name == "workflows":
            problems += workflow_problems(path, text, scripts)
    for problem in problems:
        print(problem)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
