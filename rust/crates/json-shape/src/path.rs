//! Where in a document a problem is, and the problems a validation collects.

use std::error::Error;
use std::fmt;

/// One step into a document: an object key or an array index.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PathSegment {
    Key(String),
    Index(usize),
}

/// The steps from the root of a document to a value inside it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Path(Vec<PathSegment>);

impl Path {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push_key(&mut self, key: &str) {
        self.0.push(PathSegment::Key(key.to_owned()));
    }

    pub fn push_index(&mut self, index: usize) {
        self.0.push(PathSegment::Index(index));
    }

    pub fn pop(&mut self) {
        self.0.pop();
    }

    pub fn segments(&self) -> &[PathSegment] {
        &self.0
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
