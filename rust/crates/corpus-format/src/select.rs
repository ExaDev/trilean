//! Which files under a corpus root are corpus files, by the one rule the corpus README states.

use std::collections::BTreeMap;

use crate::name::{is_name, utf16_order};

/// What a path in a corpus tree is. A caller maps whatever its file system says onto these three: a symbolic link, a
/// device or anything else that is not a regular file or a directory is [`Entry::Other`], which is never a corpus
/// file.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Entry {
    File(Vec<u8>),
    Directory,
    Other,
}

/// A corpus root as a map from the `/`-separated path of each entry, relative to the root, to the entry. A directory
/// need not be listed: it exists when a path inside it is. An empty directory is listed as [`Entry::Directory`], which
/// is how a loader reports one, since one with a name outside the rule is a problem whether it holds anything or not.
pub type Tree = BTreeMap<String, Entry>;

/// Where the corpus files are.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Layout {
    /// How many directories above a corpus file: `<package>/<area>/<name>.json` is two.
    pub depth: usize,
}

/// The result of applying the rule.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Selection {
    /// Corpus files as `/`-separated paths relative to the root, in the order a walk in UTF-16 code unit order finds
    /// them.
    pub files: Vec<String>,
    /// Entries that are neither a corpus file, a known root file nor a skipped directory, in the same order.
    pub problems: Vec<String>,
}

/// Directories that hold data cases refer to or the runners themselves, never cases, wherever they appear.
const NON_CASE_DIRECTORIES: [&str; 3] = ["fixtures", "schema", "runner"];

/// The files the corpus root itself holds.
const ROOT_FILES: [&str; 5] = [
    "README.md",
    "case.schema.json",
    "manifest.json",
    "manifest.schema.json",
    "scrub-allow.json",
];

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    File,
    Directory,
    Other,
}

/// One name in a directory: what it is and, for a directory, what is in it.
struct Node<'a> {
    kind: Kind,
    children: BTreeMap<&'a str, Node<'a>>,
}

impl Node<'_> {
    fn new(kind: Kind) -> Self {
        Node {
            kind,
            children: BTreeMap::new(),
        }
    }
}

/// The names of a tree as nested directories, to the depth a corpus file is at and no further: what is deeper than that
/// only makes the directory it is in a problem, so it is not kept. Names are slices of the tree's keys and every key is
/// walked once, so the work is linear in the total length of the keys whatever the length or depth of one path, and
/// the nesting, which the scan recurses through, is as deep as the layout and no deeper.
fn nest(tree: &Tree, layout: Layout) -> Node<'_> {
    let mut root = Node::new(Kind::Directory);
    for (path, entry) in tree {
        let mut directory = &mut root;
        let mut segments = path.split('/').enumerate().peekable();
        while let Some((depth, segment)) = segments.next() {
            let last = segments.peek().is_none();
            let kind = if !last {
                Kind::Directory
            } else {
                match entry {
                    Entry::File(_) => Kind::File,
                    Entry::Directory => Kind::Directory,
                    Entry::Other => Kind::Other,
                }
            };
            let node = directory
                .children
                .entry(segment)
                .or_insert_with(|| Node::new(kind));
            // A path inside a directory makes it a directory, whatever another entry says it is.
            if kind == Kind::Directory {
                node.kind = Kind::Directory;
            }
            if depth >= layout.depth {
                break;
            }
            directory = node;
        }
    }
    root
}

fn scan(
    directory: &Node<'_>,
    relative: &str,
    depth: usize,
    layout: Layout,
    selection: &mut Selection,
) {
    let mut names: Vec<(&&str, &Node<'_>)> = directory.children.iter().collect();
    names.sort_by(|left, right| utf16_order(left.0, right.0));
    for (name, node) in names {
        if name.starts_with('.') {
            continue;
        }
        let path = if relative.is_empty() {
            (*name).to_owned()
        } else {
            format!("{relative}/{name}")
        };
        match node.kind {
            Kind::Directory => {
                if NON_CASE_DIRECTORIES.contains(name) {
                    continue;
                }
                if depth < layout.depth && is_name(name) {
                    scan(node, &path, depth + 1, layout, selection);
                } else {
                    selection.problems.push(path);
                }
            }
            Kind::File if depth == 0 && ROOT_FILES.contains(name) => {}
            Kind::File if depth == layout.depth && name.ends_with(".json") && is_name(name) => {
                selection.files.push(path);
            }
            Kind::File | Kind::Other => selection.problems.push(path),
        }
    }
}

/// Applies the selection rule to a tree. A name starting with a dot is ignored at any depth, a directory named
/// `fixtures`, `schema` or `runner` is skipped at any depth, and everything else must be a `.json` file at
/// `layout.depth` directories down, or one of the root's own files; names are lower-case ASCII letters, digits, dots,
/// hyphens and underscores. Anything else is returned in [`Selection::problems`], for the caller to fail on.
pub fn select(tree: &Tree, layout: Layout) -> Selection {
    let mut selection = Selection::default();
    scan(&nest(tree, layout), "", 0, layout, &mut selection);
    selection
}

#[cfg(test)]
mod tests {
    use super::*;

    const LAYOUT: Layout = Layout { depth: 2 };

    fn file() -> Entry {
        Entry::File(Vec::new())
    }

    fn tree(entries: &[(&str, Entry)]) -> Tree {
        entries
            .iter()
            .map(|(path, entry)| ((*path).to_owned(), entry.clone()))
            .collect()
    }

    #[test]
    fn a_json_file_at_the_layout_depth_is_selected() {
        let selection = select(&tree(&[("pkg/area/one.json", file())]), LAYOUT);
        assert_eq!(selection.files, ["pkg/area/one.json"]);
        assert!(selection.problems.is_empty());
    }

    #[test]
    fn the_roots_own_files_are_neither_selected_nor_problems() {
        let entries: Vec<(&str, Entry)> = ROOT_FILES.iter().map(|name| (*name, file())).collect();
        assert_eq!(select(&tree(&entries), LAYOUT), Selection::default());
    }

    #[test]
    fn a_root_file_name_below_the_root_is_a_problem() {
        let selection = select(&tree(&[("pkg/manifest.json", file())]), LAYOUT);
        assert_eq!(selection.problems, ["pkg/manifest.json"]);
    }

    #[test]
    fn dot_names_are_ignored_at_any_depth() {
        let selection = select(
            &tree(&[
                (".cache/x.json", file()),
                ("pkg/.hidden/x.json", file()),
                ("pkg/area/.x.json", file()),
            ]),
            LAYOUT,
        );
        assert_eq!(selection, Selection::default());
    }

    #[test]
    fn fixtures_schema_and_runner_are_skipped_at_any_depth() {
        let selection = select(
            &tree(&[
                ("fixtures/a.json", file()),
                ("pkg/schema/a.json", file()),
                ("pkg/area/runner/a.json", file()),
            ]),
            LAYOUT,
        );
        assert_eq!(selection, Selection::default());
    }

    #[test]
    fn a_name_outside_the_rule_is_a_problem() {
        let selection = select(
            &tree(&[
                ("pkg/area/Upper.json", file()),
                ("pkg/area/notes.txt", file()),
                ("pkg/area/😀.txt", file()),
                ("Bad/area/x.json", file()),
            ]),
            LAYOUT,
        );
        assert!(selection.files.is_empty());
        assert_eq!(selection.problems.len(), 4);
    }

    #[test]
    fn a_file_at_the_wrong_depth_is_a_problem() {
        let selection = select(
            &tree(&[
                ("stray.json", file()),
                ("pkg/stray.json", file()),
                ("pkg/a/b/c.json", file()),
            ]),
            LAYOUT,
        );
        assert!(selection.files.is_empty());
        assert_eq!(
            selection.problems,
            ["pkg/a/b", "pkg/stray.json", "stray.json"]
        );
    }

    #[test]
    fn an_empty_directory_with_a_bad_name_is_a_problem_and_a_good_one_is_not() {
        let selection = select(
            &tree(&[("Bad", Entry::Directory), ("pkg", Entry::Directory)]),
            LAYOUT,
        );
        assert_eq!(selection.problems, ["Bad"]);
    }

    #[test]
    fn a_link_or_other_entry_is_never_selected() {
        let selection = select(&tree(&[("pkg/area/link.json", Entry::Other)]), LAYOUT);
        assert!(selection.files.is_empty());
        assert_eq!(selection.problems, ["pkg/area/link.json"]);
    }

    #[test]
    fn results_are_in_utf16_order() {
        let selection = select(
            &tree(&[
                ("b/a/x.json", file()),
                ("a/a/y.json", file()),
                ("a/a/x.json", file()),
            ]),
            LAYOUT,
        );
        assert_eq!(selection.files, ["a/a/x.json", "a/a/y.json", "b/a/x.json"]);
    }

    #[test]
    fn a_path_inside_a_directory_makes_it_a_directory() {
        let selection = select(
            &tree(&[("pkg", Entry::Other), ("pkg/area/one.json", file())]),
            LAYOUT,
        );
        assert_eq!(selection.files, ["pkg/area/one.json"]);
    }

    #[test]
    fn a_path_of_many_segments_costs_work_linear_in_its_length() {
        // Keeping every prefix of the path as a key, or copying it, costs the square of the length: 400,000 segments is some
        // hundred billion bytes touched, which takes minutes. Walking the path once takes milliseconds.
        let path = vec!["a"; 400_000].join("/");
        let selection = select(&tree(&[(path.as_str(), file())]), LAYOUT);
        assert_eq!(selection.files, Vec::<String>::new());
        assert_eq!(selection.problems.len(), 1);
    }

    #[test]
    fn a_tree_of_many_siblings_is_selected_in_order() {
        let paths: Vec<String> = (0..50_000).map(|n| format!("p/a/{n:06}.json")).collect();
        let entries: Vec<(&str, Entry)> =
            paths.iter().map(|path| (path.as_str(), file())).collect();
        let selection = select(&tree(&entries), LAYOUT);
        assert_eq!(selection.files, paths);
    }
}
