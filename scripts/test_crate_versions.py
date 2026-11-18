"""Tests for crate-versions.py, over manifest and lock texts and stand-ins for crates.io."""
from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location("crate_versions", Path(__file__).with_name("crate-versions.py"))
assert SPEC is not None and SPEC.loader is not None
versions = importlib.util.module_from_spec(SPEC)
# Registered before it runs, because a dataclass looks its own module up while it is defined.
sys.modules[SPEC.name] = versions
SPEC.loader.exec_module(versions)

Crate = versions.Crate
MANIFEST = Path("rust/crates/example/Cargo.toml")


def crate(name: str = "example", version: str = "1.2.3", package: str | None = "pkg", required_at: tuple[tuple[str, str], ...] = ()) -> object:
    return Crate(name, version, MANIFEST, package, required_at)


def package_versions(name: str) -> str | None:
    return {"pkg": "1.2.3"}.get(name)


class Check(unittest.TestCase):
    def test_a_crate_at_its_package_version_required_at_it_passes(self) -> None:
        self.assertEqual(versions.problems_in([crate(required_at=(("user", "^1.2.3"),))], package_versions), [])

    def test_a_crate_behind_its_package_is_named_with_the_command_that_fixes_it(self) -> None:
        problems = versions.problems_in([crate(version="1.2.2")], package_versions)
        self.assertEqual(problems, ["example: version 1.2.2, but pkg is 1.2.3 (scripts/crate-versions.py set pkg 1.2.3)"])

    def test_a_sibling_requiring_another_version_is_named(self) -> None:
        problems = versions.problems_in([crate(required_at=(("user", "^1.2.2"),))], package_versions)
        self.assertEqual(problems, ["user requires example at ^1.2.2, not ^1.2.3"])

    def test_a_published_crate_with_no_package_is_refused(self) -> None:
        self.assertEqual(len(versions.problems_in([crate(package=None)], package_versions)), 1)

    def test_a_package_that_does_not_exist_is_refused(self) -> None:
        self.assertEqual(len(versions.problems_in([crate(package="missing")], package_versions)), 1)

    def test_a_workspace_that_publishes_nothing_is_refused(self) -> None:
        self.assertEqual(versions.problems_in([], package_versions), ["the workspace publishes no crate"])


class Set(unittest.TestCase):
    def test_the_package_version_is_replaced_and_a_dependency_version_is_not(self) -> None:
        text = '[package]\nname = "example"\ndescription = "x"\nversion = "0.0.0"\nedition.workspace = true\n\n[dependencies]\nother = { version = "0.0.0" }\n'
        self.assertEqual(versions.set_version_in_manifest(text, "2.0.0"), text.replace('version = "0.0.0"\nedition', 'version = "2.0.0"\nedition'))

    def test_an_inherited_version_is_refused(self) -> None:
        with self.assertRaises(SystemExit):
            versions.set_version_in_manifest('[package]\nname = "example"\nversion.workspace = true\n', "2.0.0")

    def test_the_workspace_requirement_of_that_crate_alone_is_replaced(self) -> None:
        text = '[workspace.dependencies]\nexample = { path = "crates/example", version = "1.0.0" }\nexample-derive = { path = "crates/example-derive", version = "1.0.0" }\n'
        expected = text.replace('example", version = "1.0.0"', 'example", version = "2.0.0"')
        self.assertEqual(versions.set_requirement(text, "example", "2.0.0"), expected)

    def test_the_lock_entry_of_the_workspace_crate_alone_is_replaced(self) -> None:
        text = '[[package]]\nname = "example"\nversion = "1.0.0"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n\n[[package]]\nname = "example"\nversion = "1.0.0"\ndependencies = []\n'
        expected = text[: text.rindex('version = "1.0.0"')] + 'version = "2.0.0"\ndependencies = []\n'
        self.assertEqual(versions.set_locked_version(text, "example", "2.0.0"), expected)

    def test_a_version_that_is_not_a_release_is_refused(self) -> None:
        with self.assertRaises(SystemExit):
            versions.set_versions([], "pkg", "next")


class Unpublished(unittest.TestCase):
    def test_a_crate_whose_version_is_held_is_left_out_and_one_whose_version_is_not_is_listed(self) -> None:
        held = {"a": {"1.2.3"}, "b": {"1.2.2"}}
        missing, never = versions.unpublished([crate("a"), crate("b")], held.get)
        self.assertEqual(([c.name for c in missing], never), (["b"], []))

    def test_a_crate_never_published_is_reported_apart(self) -> None:
        missing, never = versions.unpublished([crate("a")], lambda name: None)
        self.assertEqual((missing, [c.name for c in never]), ([], ["a"]))

    def test_the_index_path_follows_the_sharding_of_the_sparse_index(self) -> None:
        self.assertEqual([versions.index_path(name) for name in ("a", "ab", "abc", "Trilean-Eval")], ["1/a", "2/ab", "3/a/abc", "tr/il/trilean-eval"])

    def test_the_arguments_name_each_crate_after_its_own_flag(self) -> None:
        self.assertEqual(versions.arguments([crate("a"), crate("b")]), "-p\na\n-p\nb\n")


if __name__ == "__main__":
    unittest.main()
