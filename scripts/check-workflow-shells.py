#!/usr/bin/env python3
"""Fails when a step's shell could finish successfully after a command inside it failed.

A `run:` step with no `shell:` runs as `bash -e {0}`, where a pipeline's status is its last command's, so `out=$(fails | tr ...)` succeeds; a step given `shell: bash` runs as `bash --noprofile --norc -eo pipefail {0}`, where it does not (https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#defaultsrunshell). So every workflow sets `defaults: run: shell: bash`, and every `shell:` a workflow or composite action names is `bash`. A process substitution (`< <(...)`) hides its command's status from both `-e` and `pipefail`, so none may appear; capture the output in a variable first, where `-e` sees the failure.

Usage: check-workflow-shells.py. It reads .github/workflows and .github/actions.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

GITHUB = Path(__file__).resolve().parent.parent / ".github"

# `defaults:` at the top level, then `run:` and `shell: bash` nested under it, each at a deeper indentation than the line before.
DEFAULTS = re.compile(r"^defaults:[ \t]*\n(?:[ \t]*(?:#.*)?\n)*([ \t]+)run:[ \t]*\n(?:[ \t]*(?:#.*)?\n)*\1([ \t]+)shell:[ \t]*bash[ \t]*$", re.MULTILINE)
SHELL = re.compile(r"^[ \t]*(?:-[ \t]+)?shell:[ \t]*(\S+)", re.MULTILINE)
PROCESS_SUBSTITUTION = re.compile(r"<\(")


def problems_in(name: str, text: str, *, workflow: bool) -> list[str]:
    """Every rule `text`, the workflow or composite action named `name`, breaks."""
    problems: list[str] = []
    if workflow and DEFAULTS.search(text) is None:
        problems.append(f"{name}: has no top-level `defaults: run: shell: bash`, so its run steps run without pipefail")
    for match in SHELL.finditer(text):
        if match.group(1) != "bash":
            line = text.count("\n", 0, match.start()) + 1
            problems.append(f"{name}:{line}: names shell {match.group(1)}, which runs without pipefail; use bash")
    for number, line in enumerate(text.splitlines(), start=1):
        # A comment may name the construct; only a line that runs can use it.
        if not line.lstrip().startswith("#") and PROCESS_SUBSTITUTION.search(line):
            problems.append(f"{name}:{number}: a process substitution hides its command's failure; capture the output in a variable first")
    return problems


def main() -> int:
    problems: list[str] = []
    for path in sorted((GITHUB / "workflows").glob("*.yml")):
        problems += problems_in(str(path.relative_to(GITHUB.parent)), path.read_text(encoding="utf-8"), workflow=True)
    for path in sorted((GITHUB / "actions").glob("*/action.yml")):
        problems += problems_in(str(path.relative_to(GITHUB.parent)), path.read_text(encoding="utf-8"), workflow=False)
    for problem in problems:
        print(problem, file=sys.stderr)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
