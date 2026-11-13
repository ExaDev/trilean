"""Tests for check-workspace-members.py, over throwaway workspaces."""
from __future__ import annotations

import importlib.util
import tempfile
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location("check_workspace_members", Path(__file__).with_name("check-workspace-members.py"))
assert SPEC is not None and SPEC.loader is not None
checker = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(checker)

ROOT = """[workspace]
resolver = "2"
members = ["crates/*"]
exclude = ["crates/scratch"]

[workspace.package]
edition = "2024"
rust-version = "1.99.1"
license = "MIT"

[workspace.lints.rust]
unsafe_code = "deny"
"""

GOOD = """[package]
name = "good"
version = "0.0.0"
edition.workspace = true
rust-version.workspace = true
license.workspace = true

[lints]
workspace = true
"""


def workspace(crates: dict[str, str], root: str = ROOT) -> Path:
    base = Path(tempfile.mkdtemp())
    (base / "Cargo.toml").write_text(root)
    for name, manifest in crates.items():
        (base / "crates" / name).mkdir(parents=True)
        (base / "crates" / name / "Cargo.toml").write_text(manifest)
    return base


class CheckWorkspaceMembers(unittest.TestCase):
    def test_a_crate_that_inherits_everything_passes(self) -> None:
        self.assertEqual(checker.problems_in(workspace({"good": GOOD})), [])

    def test_a_crate_without_the_lints_stanza_fails(self) -> None:
        crate = GOOD.replace("[lints]\nworkspace = true\n", "")
        self.assertEqual(checker.problems_in(workspace({"bad": crate})), ["crates/bad: [lints] workspace = true is missing"])

    def test_a_crate_with_its_own_edition_fails(self) -> None:
        crate = GOOD.replace("edition.workspace = true", 'edition = "2021"')
        self.assertEqual(
            checker.problems_in(workspace({"bad": crate})),
            ["crates/bad: edition is not inherited with edition.workspace = true"],
        )

    def test_a_crate_without_a_licence_fails(self) -> None:
        crate = GOOD.replace("license.workspace = true\n", "")
        self.assertEqual(
            checker.problems_in(workspace({"bad": crate})),
            ["crates/bad: license is not inherited with license.workspace = true"],
        )

    def test_an_excluded_crate_is_not_checked(self) -> None:
        self.assertEqual(checker.problems_in(workspace({"good": GOOD, "scratch": "[package]\nname = 'scratch'\n"})), [])

    def test_a_workspace_that_does_not_set_the_edition_fails(self) -> None:
        root = ROOT.replace('edition = "2024"\n', "")
        self.assertIn("[workspace.package] does not set edition", checker.problems_in(workspace({"good": GOOD}, root)))

    def test_a_workspace_without_members_fails(self) -> None:
        self.assertIn("the workspace has no member crates", checker.problems_in(workspace({})))


if __name__ == "__main__":
    unittest.main()
