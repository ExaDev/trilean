"""Tests for check-workflow-shells.py, over workflow and action texts."""
from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location("check_workflow_shells", Path(__file__).with_name("check-workflow-shells.py"))
assert SPEC is not None and SPEC.loader is not None
checker = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(checker)

GOOD = """name: CI

on: push

# Every run step fails on any failed command of a pipeline.
defaults:
  run:
    shell: bash

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: crates=$(python3 list.py | tr '\\n' ' ')
      # mapfile -t crates < <(python3 list.py) would hide a failure.
      - shell: bash
        run: echo ok
"""


class CheckWorkflowShells(unittest.TestCase):
    def test_a_workflow_with_bash_defaults_passes(self) -> None:
        self.assertEqual(checker.problems_in("ci.yml", GOOD, workflow=True), [])

    def test_a_workflow_without_defaults_fails(self) -> None:
        text = GOOD.replace("defaults:\n  run:\n    shell: bash\n", "")
        self.assertEqual(len(checker.problems_in("ci.yml", text, workflow=True)), 1)

    def test_defaults_naming_another_shell_fail(self) -> None:
        text = GOOD.replace("    shell: bash\n\njobs", "    shell: sh\n\njobs")
        problems = checker.problems_in("ci.yml", text, workflow=True)
        self.assertEqual(len(problems), 2, problems)

    def test_defaults_nested_in_a_job_do_not_count(self) -> None:
        text = GOOD.replace("defaults:\n  run:\n    shell: bash\n", "").replace("    runs-on:", "    defaults:\n      run:\n        shell: bash\n    runs-on:")
        self.assertEqual(len(checker.problems_in("ci.yml", text, workflow=True)), 1)

    def test_a_step_naming_another_shell_fails(self) -> None:
        text = GOOD.replace("      - shell: bash\n", "      - shell: sh\n")
        problems = checker.problems_in("ci.yml", text, workflow=True)
        self.assertEqual(len(problems), 1, problems)
        self.assertIn("ci.yml:16", problems[0])

    def test_a_process_substitution_fails(self) -> None:
        text = GOOD.replace("echo ok", "mapfile -t crates < <(python3 list.py)")
        problems = checker.problems_in("ci.yml", text, workflow=True)
        self.assertEqual(len(problems), 1, problems)
        self.assertIn("ci.yml:17", problems[0])

    def test_an_action_needs_no_defaults(self) -> None:
        action = "runs:\n  using: composite\n  steps:\n    - shell: bash\n      run: echo ok\n"
        self.assertEqual(checker.problems_in("action.yml", action, workflow=False), [])

    def test_this_repository_passes(self) -> None:
        self.assertEqual(checker.main(), 0)


if __name__ == "__main__":
    unittest.main()
