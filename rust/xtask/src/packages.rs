//! The npm packages built from Rust, and what is particular to each.

/// A package built from a binding crate.
pub struct Package {
    /// The package's name, and its directory under `packages`.
    pub name: &'static str,
    /// The crate whose wasm module the package ships.
    pub binding: &'static str,
    /// The stem of the files `wasm-bindgen` writes (`<glue>.js`, `<glue>_bg.wasm`).
    pub glue: &'static str,
    /// The module of error classes the binding imports as `./errors.js`, as JavaScript.
    pub errors_js: &'static str,
    /// The declarations of those classes.
    pub errors_declarations: &'static str,
}

const PACKAGES: [Package; 1] = [Package {
    name: "trilean-regex",
    binding: "trilean-regex-wasm",
    glue: "trilean_regex",
    errors_js: r#"/** A pattern the parser refuses. `message` names the index, the reason, the pattern and a caret under the position. */
export class RegexParseError extends Error {
  constructor(message, pattern, index) {
    super(message);
    this.name = "RegexParseError";
    this.pattern = pattern;
    this.index = index;
  }
}

/** A pattern in the grammar with a construct that means something else in an ECMAScript regular expression. */
export class UnsupportedConstructError extends Error {
  constructor(message, index, construct) {
    super(message);
    this.name = "UnsupportedConstructError";
    this.index = index;
    this.construct = construct;
  }
}
"#,
    errors_declarations: r#"/** A pattern the parser refuses. `message` names the index, the reason, the pattern and a caret under the position; `index` is the offset in UTF-16 code units into `pattern`. */
export declare class RegexParseError extends Error {
  readonly pattern: string;
  readonly index: number;
  constructor(message: string, pattern: string, index: number);
}

/** A pattern in the grammar with a construct that means something else in an ECMAScript regular expression; `index` is its offset in UTF-16 code units and `construct` its source text. */
export declare class UnsupportedConstructError extends Error {
  readonly index: number;
  readonly construct: string;
  constructor(message: string, index: number, construct: string);
}
"#,
}];

impl Package {
    pub fn named(name: &str) -> Option<&'static Package> {
        PACKAGES.iter().find(|package| package.name == name)
    }

    pub fn names() -> Vec<&'static str> {
        PACKAGES.iter().map(|package| package.name).collect()
    }
}
