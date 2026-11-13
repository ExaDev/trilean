"""Tests for check-cargo-locked.py."""
from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location("check_cargo_locked", Path(__file__).with_name("check-cargo-locked.py"))
assert SPEC is not None and SPEC.loader is not None
checker = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(checker)

YAML = Path("ci.yml")
SHELL = Path("run.sh")
PYTHON = Path("tool.py")


def problems(path: Path, text: str) -> list[str]:
    return checker.file_problems(path, text)


class Invocations(unittest.TestCase):
    def test_a_locked_command_passes(self) -> None:
        self.assertEqual(problems(SHELL, "cargo test --locked --all-targets\n"), [])

    def test_an_unlocked_command_fails(self) -> None:
        self.assertEqual(len(problems(SHELL, "cargo test --all-targets\n")), 1)

    def test_a_locked_command_does_not_excuse_the_one_after_it_on_the_same_line(self) -> None:
        self.assertEqual(len(problems(SHELL, "cargo test --locked && cargo build\n")), 1)

    def test_every_invocation_on_a_line_is_checked(self) -> None:
        self.assertEqual(len(problems(SHELL, "cargo build; cargo test | cat\n")), 2)

    def test_a_subcommand_that_never_reads_the_lock_is_exempt(self) -> None:
        self.assertEqual(problems(SHELL, "cargo fmt --check\n"), [])

    def test_the_subcommand_is_found_after_flags(self) -> None:
        self.assertEqual(len(problems(SHELL, "cargo --quiet deny check\n")), 1)

    def test_a_named_toolchain_fails(self) -> None:
        self.assertEqual(len(problems(SHELL, "cargo +nightly build --locked\n")), 1)

    def test_a_yaml_run_line_is_checked(self) -> None:
        self.assertEqual(len(problems(YAML, "        run: cargo deny check bans\n")), 1)
        self.assertEqual(problems(YAML, "        run: cargo deny --locked check bans\n"), [])

    def test_comment_lines_and_prose_are_not_invocations(self) -> None:
        self.assertEqual(problems(YAML, "  # cargo test runs the tests\n  name: cargo-deny\n"), [])

    def test_a_python_list_is_checked_and_its_prose_is_not(self) -> None:
        self.assertEqual(problems(PYTHON, '"""Runs `cargo tree` in rust/."""\n'), [])
        self.assertEqual(len(problems(PYTHON, 'subprocess.run(["cargo", "tree", "--workspace"])\n')), 1)
        self.assertEqual(problems(PYTHON, 'subprocess.run(["cargo", "tree", "--locked", "--workspace"])\n'), [])


WORKFLOW = """name: CI
jobs:
  rust:
    steps:
      - name: Install the pinned toolchain
        run: rustup toolchain install
      - run: cargo test --locked
  bare:
    steps:
      - run: cargo test --locked
  indirect:
    steps:
      - run: sh scripts/rust-checks.sh
  docs:
    steps:
      - run: echo hello
"""


class Toolchain(unittest.TestCase):
    def test_a_job_that_runs_cargo_without_the_toolchain_step_fails(self) -> None:
        scripts = {"scripts/rust-checks.sh": "cargo test --locked\n"}
        found = checker.workflow_problems(YAML, WORKFLOW, scripts)
        self.assertEqual(sorted(found), [f"ci.yml: job {name} runs cargo without `rustup toolchain install`" for name in ("bare", "indirect")])


if __name__ == "__main__":
    unittest.main()
