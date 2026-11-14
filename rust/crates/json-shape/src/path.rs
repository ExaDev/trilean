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
