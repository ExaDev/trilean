//! The place of a value inside a document, kept as a stack of steps and written out only when a problem is reported, so a
//! walk over a large document costs the size of the document and not the size of the document times the length of a path.

use std::fmt::Write;

/// One step from a value to a member of it.
#[derive(Clone, Copy, Debug)]
pub(crate) enum Step<'a> {
    /// A member of an object, by name.
    Key(&'a str),
    /// A member of an object whose name is UTF-16 code units, which may hold an unpaired surrogate.
    Units(&'a [u16]),
    /// An element of an array.
    Index(usize),
}

/// The steps from the root to the value being read.
pub(crate) type Trail<'a> = Vec<Step<'a>>;

#[cfg(test)]
thread_local! {
    /// How many trails this thread has written out, so a test can count the work and not time it.
    pub(crate) static RENDERED: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// The trail as `$` followed by `.name` and `[index]` steps.
pub(crate) fn render(trail: &[Step<'_>]) -> String {
    #[cfg(test)]
    RENDERED.with(|count| count.set(count.get() + 1));
    let mut text = String::from("$");
    for step in trail {
        match step {
            Step::Key(name) => {
                let _ = write!(text, ".{name}");
            }
            Step::Units(units) => {
                let _ = write!(text, ".{}", String::from_utf16_lossy(units));
            }
            Step::Index(position) => {
                let _ = write!(text, "[{position}]");
            }
        }
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_trail_is_written_as_a_path() {
        assert_eq!(render(&[]), "$");
        let units = [0x61u16, 0x62];
        assert_eq!(
            render(&[Step::Key("a"), Step::Index(3), Step::Units(&units)]),
            "$.a[3].ab"
        );
    }
}
