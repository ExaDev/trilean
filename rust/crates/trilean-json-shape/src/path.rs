//! Where in a document a problem is, and the problems a validation collects.

use std::collections::HashMap;
use std::error::Error;
use std::fmt;

/// One step into a document: an object key or an array index.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PathSegment {
    Key(String),
    Index(usize),
}

/// The steps from the root of a document to a value inside it. It also carries what a conversion of one document
/// remembers between its nodes (which alternative of a union accepted which value), so that choosing among
/// alternatives costs each value once.
/// Only this crate makes one (`Shape::from_json` makes a fresh one for each document), so what it remembers cannot
/// outlive the document it was made on.
#[derive(Debug)]
pub struct Path {
    segments: Vec<PathSegment>,
    pub(crate) memo: HashMap<(usize, usize), bool>,
}

impl Path {
    pub(crate) fn new() -> Self {
        Path {
            segments: Vec::new(),
            memo: HashMap::new(),
        }
    }

    pub fn push_key(&mut self, key: &str) {
        self.segments.push(PathSegment::Key(key.to_owned()));
    }

    pub fn push_index(&mut self, index: usize) {
        self.segments.push(PathSegment::Index(index));
    }

    pub fn pop(&mut self) {
        self.segments.pop();
    }

    pub fn segments(&self) -> &[PathSegment] {
        &self.segments
    }
}

/// One problem with a document, at the path of the value it is about.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Issue {
    pub path: Vec<PathSegment>,
    pub message: String,
}

impl Issue {
    /// The path as an RFC 6901 JSON Pointer, which is the empty string for the root.
    pub fn pointer(&self) -> String {
        let mut pointer = String::new();
        for segment in &self.path {
            pointer.push('/');
            match segment {
                PathSegment::Key(key) => {
                    pointer.push_str(&key.replace('~', "~0").replace('/', "~1"))
                }
                PathSegment::Index(index) => pointer.push_str(&index.to_string()),
            }
        }
        pointer
    }
}

impl fmt::Display for Issue {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let pointer = self.pointer();
        let at = if pointer.is_empty() {
            "(root)"
        } else {
            &pointer
        };
        write!(formatter, "{at}: {}", self.message)
    }
}

/// Every problem a validation found, never empty when it is an error.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Issues(pub Vec<Issue>);

impl Issues {
    pub fn at(path: &Path, message: impl Into<String>) -> Self {
        Issues(vec![Issue {
            path: path.segments().to_vec(),
            message: message.into(),
        }])
    }
}

impl fmt::Display for Issues {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        for (position, issue) in self.0.iter().enumerate() {
            if position > 0 {
                formatter.write_str("; ")?;
            }
            write!(formatter, "{issue}")?;
        }
        Ok(())
    }
}

impl Error for Issues {}

#[cfg(test)]
mod tests {
    use crate::{Path, Shape, Value};

    #[derive(Shape, Debug, PartialEq)]
    #[serde(untagged)]
    enum Either {
        Count(u8),
        Text(String),
    }

    /// What one conversion remembers is keyed by where a value sits, so a `Path` that met a second document at the
    /// same address would answer for the first. Here the second document is the same place holding another value.
    #[test]
    fn a_path_kept_across_two_documents_would_answer_for_the_first() {
        let mut document = Value::Number(1.0);
        let mut path = Path::new();
        assert_eq!(Either::build(&document, &mut path), Ok(Either::Count(1)));
        document = Value::String("a".to_owned());
        assert!(
            Either::build(&document, &mut path).is_err(),
            "the memory of the first document is stale for the second, which is why no caller may keep a Path"
        );
        // `from_json`, the only way a caller converts, makes a fresh Path for each document.
        assert_eq!(
            Either::from_json(&document),
            Ok(Either::Text("a".to_owned()))
        );
    }

    #[test]
    fn a_fresh_path_has_no_memory() {
        let path = Path::new();
        assert!(path.memo.is_empty());
    }
}
