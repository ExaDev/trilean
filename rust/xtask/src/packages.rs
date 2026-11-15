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

const PACKAGES: [Package; 2] = [
    Package {
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

/** A bug in the package: Rust panicked. `message` carries the panic's message and location. The instance that panicked is spent and the panic is to be reported. */
export class InternalError extends Error {
  constructor(message) {
    super(message);
    this.name = "InternalError";
  }
}

/** An input a compiled pattern may not be tested against: it is longer than the limit, or its length allows the pattern's states more work than the limit. `message` names the numbers and echoes no input. */
export class RegexInputError extends Error {
  constructor(message) {
    super(message);
    this.name = "RegexInputError";
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

/** A bug in the package: Rust panicked. `message` carries the panic's message and location. The instance that panicked is spent and the panic is to be reported. */
export declare class InternalError extends Error {
  constructor(message: string);
}

/** An input a compiled pattern may not be tested against: it is longer than the limit, or its length allows the pattern's states more work than the limit. `message` names the numbers and echoes no input. */
export declare class RegexInputError extends Error {
  constructor(message: string);
}
"#,
    },
    Package {
        name: "corpus-format",
        binding: "corpus-format-wasm",
        glue: "corpus_format",
        errors_js: r#"/** A document or an argument the package refuses: JSON text that does not parse, a manifest that is not well-formed, a name that is not a requirement. `message` says which. */
export class CorpusFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = "CorpusFormatError";
  }
}

/** A value whose encodings do not decode: a `$`-prefixed member that is not one of the closed set, an encoding with another member beside it, or one whose value is of the wrong form. `path` is the place in the value, as `$` followed by `.name` and `[index]` steps. */
export class DecodeError extends Error {
  constructor(message, path) {
    super(message);
    this.name = "DecodeError";
    this.path = path;
  }
}

/** A bug in the package: Rust panicked. `message` carries the panic's message and location. The instance that panicked is spent and the panic is to be reported. */
export class InternalError extends Error {
  constructor(message) {
    super(message);
    this.name = "InternalError";
  }
}
"#,
        errors_declarations: r#"/** A document or an argument the package refuses: JSON text that does not parse, a manifest that is not well-formed, a name that is not a requirement. `message` says which. */
export declare class CorpusFormatError extends Error {
  constructor(message: string);
}

/** A value whose encodings do not decode: a `$`-prefixed member that is not one of the closed set, an encoding with another member beside it, or one whose value is of the wrong form. `path` is the place in the value, as `$` followed by `.name` and `[index]` steps. */
export declare class DecodeError extends Error {
  readonly path: string;
  constructor(message: string, path: string);
}

/** A bug in the package: Rust panicked. `message` carries the panic's message and location. The instance that panicked is spent and the panic is to be reported. */
export declare class InternalError extends Error {
  constructor(message: string);
}
"#,
    },
];

impl Package {
    pub fn named(name: &str) -> Option<&'static Package> {
        PACKAGES.iter().find(|package| package.name == name)
    }

    pub fn names() -> Vec<&'static str> {
        PACKAGES.iter().map(|package| package.name).collect()
    }
}
