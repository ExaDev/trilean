//! The files of `dist` that `wasm-bindgen` does not write.

use std::collections::BTreeSet;
use std::fs;
use std::path::Path;

use crate::packages::{Flavour, Package};

/// What `write_support_files` wrote that a package manifest must name.
pub struct Written {
    /// The files of `dist` the manifest's `exports` and `imports` point at.
    pub entry_points: BTreeSet<String>,
    /// The files whose sizes the build reports, with their sizes in bytes: the module and its inlined form.
    pub sizes: Vec<(String, usize)>,
}

/// The `#init` module for Node, Bun and Deno. The module's bytes are in the package as a generated base64 string (see `inline_module`), decoded once with `atob`, which Node, Bun and Deno all have, and compiled synchronously, so importing the package reads no file and waits for nothing, and a bundle of it for a server is a single file that needs nothing beside it.
fn init_node(package: &Package) -> String {
    format!(
        "import {{ initSync }} from \"./{glue}.js\";\nimport {{ base64 }} from \"./{glue}_inline.js\";\n\ninitSync({{ module: Uint8Array.from(atob(base64), (character) => character.charCodeAt(0)) }});\n",
        glue = package.glue
    )
}

/// The module's bytes as the base64 text of an ES module, which only `init.node.js` imports.
fn inline_module(wasm: &[u8]) -> String {
    format!("export const base64 = \"{}\";\n", base64(wasm))
}

/// Standard base64 with padding, which `atob` reads.
fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut text = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let group = chunk.iter().enumerate().fold(0u32, |group, (at, byte)| {
            group | u32::from(*byte) << (16 - 8 * at)
        });
        for at in 0..4 {
            if at <= chunk.len() {
                text.push(char::from(ALPHABET[(group >> (18 - 6 * at) & 63) as usize]));
            } else {
                text.push('=');
            }
        }
    }
    text
}

/// The `#init` module for Cloudflare Workers, which imports a `.wasm` file as an already compiled module.
fn init_workerd(package: &Package) -> String {
    format!(
        "import {{ initSync }} from \"./{glue}.js\";\nimport wasm from \"./{glue}_bg.wasm\";\n\ninitSync({{ module: wasm }});\n",
        glue = package.glue
    )
}

/// The `#init` module for browsers and bundlers, which fetch the module and wait for it with top-level await.
fn init_browser(package: &Package) -> String {
    format!(
        "import init from \"./{glue}.js\";\n\nawait init({{ module_or_path: new URL(\"./{glue}_bg.wasm\", import.meta.url) }});\n",
        glue = package.glue
    )
}

/// The names `wasm-bindgen` exports, one declaration per line, by the keyword that introduces it. The glue and its declarations are the generator's output, one `export <keyword> <name>` to a line.
fn exported(text: &str, keywords: &[&str]) -> Vec<String> {
    let mut names = Vec::new();
    for line in text.lines() {
        let Some(rest) = line.strip_prefix("export ") else {
            continue;
        };
        let rest = rest.strip_prefix("declare ").unwrap_or(rest);
        for keyword in keywords {
            if let Some(after) = rest.strip_prefix(keyword)
                && let Some(after) = after.strip_prefix(' ')
            {
                let name: String = after
                    .chars()
                    .take_while(|c| c.is_alphanumeric() || *c == '_' || *c == '$')
                    .collect();
                if !name.is_empty() {
                    names.push(name);
                }
            }
        }
    }
    names
}

/// The function of the binding that is handed the error classes, which the entry point calls and does not offer.
const REGISTER_ERRORS: &str = "registerErrorClasses";

/// What the binding exports for the entry point's own use and for the tests of the binding, and so is not part of the package's API.
const HIDDEN: [&str; 2] = [REGISTER_ERRORS, "panicForTesting"];

/// What `wasm-bindgen` exports only to start the module, which the `#init` modules call and the package does not offer.
fn is_loader_name(name: &str) -> bool {
    HIDDEN.contains(&name)
        || matches!(
            name,
            "initSync" | "InitInput" | "InitOutput" | "SyncInitInput"
        )
}

fn public_names(text: &str, keywords: &[&str]) -> Vec<String> {
    exported(text, keywords)
        .into_iter()
        .filter(|name| !is_loader_name(name))
        .collect()
}

/// The package's entry point, which starts the module through `init` (`#init` in the package, and the Node module beside it in the copy the tests load, since a package's `imports` field names the published files) and re-exports the generated API and the error classes.
fn index_js(package: &Package, glue_js: &str, errors: &[String], init: &str) -> String {
    let values = public_names(glue_js, &["function", "class"]).join(", ");
    let classes = public_names(glue_js, &["class"]);
    let imported = if classes.is_empty() {
        String::new()
    } else {
        format!(", {}", classes.join(", "))
    };
    // A class that owns memory in the module is freed by its finaliser once the loop yields, or at once by `free()`. wasm-bindgen's `free()` throws on a second call and `Symbol.dispose` calls it, so `using` followed by `free()` would throw; `free` here does nothing for an object already freed.
    let idempotent: String = classes
        .iter()
        .map(|class| format!(
            "{class}.prototype.free = ((free) => function () {{\n  if (this.__wbg_ptr !== 0) {{\n    free.call(this);\n  }}\n}})({class}.prototype.free);\nif (Symbol.dispose) {{\n  {class}.prototype[Symbol.dispose] = {class}.prototype.free;\n}}\n"
        ))
        .collect();
    format!(
        "import \"{init}\";\nimport {{ {REGISTER_ERRORS}{imported} }} from \"./{glue}.js\";\nimport {{ {errors} }} from \"./errors.js\";\n\n{REGISTER_ERRORS}({errors});\n{idempotent}\nexport {{ {values} }} from \"./{glue}.js\";\nexport {{ {errors} }} from \"./errors.js\";\n",
        glue = package.glue,
        errors = errors.join(", ")
    )
}

/// The declarations of the generated module without what needs more of a consumer's project than the package's own types do. The loader's declarations name `RequestInfo`, `URL`, `Response`, `BufferSource` and `WebAssembly`, which only the DOM library has, and `[Symbol.dispose]` needs `esnext.disposable`; the loader is not part of the package's API and `Symbol.dispose` is still on the objects at run time, so neither is declared.
fn consumer_declarations(glue_declarations: &str) -> String {
    let api = glue_declarations
        .split("\nexport type InitInput")
        .next()
        .unwrap_or(glue_declarations);
    let mut kept: Vec<&str> = api
        .lines()
        .filter(|line| !line.contains("[Symbol.dispose]"))
        .collect();
    while kept.last().is_some_and(|line| line.is_empty()) {
        kept.pop();
    }
    kept.join("\n") + "\n"
}

fn index_declarations(package: &Package, glue_declarations: &str, errors: &[String]) -> String {
    let values = public_names(glue_declarations, &["function", "class"]).join(", ");
    let types = public_names(glue_declarations, &["interface", "type"]).join(", ");
    format!(
        "export {{ {values} }} from \"./{glue}.js\";\nexport type {{ {types} }} from \"./{glue}.js\";\nexport {{ {errors} }} from \"./errors.js\";\n",
        glue = package.glue,
        errors = errors.join(", ")
    )
}

/// The Standard Schema v1 types (https://standardschema.dev), which the spec asks a library to copy into its own
/// declarations so that a consumer needs no dependency to read them.
const STANDARD_SCHEMA_TYPES: &str = r#"/** The Standard Schema interface (https://standardschema.dev), version 1. */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": StandardSchemaV1.Props<Input, Output>;
}

export declare namespace StandardSchemaV1 {
  interface Props<Input = unknown, Output = Input> {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => Result<Output> | Promise<Result<Output>>;
    readonly types?: Types<Input, Output> | undefined;
  }
  type Result<Output> = SuccessResult<Output> | FailureResult;
  interface SuccessResult<Output> {
    readonly value: Output;
    readonly issues?: undefined;
  }
  interface FailureResult {
    readonly issues: ReadonlyArray<Issue>;
  }
  interface Issue {
    readonly message: string;
    readonly path?: ReadonlyArray<PropertyKey | PathSegment> | undefined;
  }
  interface PathSegment {
    readonly key: PropertyKey;
  }
  interface Types<Input = unknown, Output = Input> {
    readonly input: Input;
    readonly output: Output;
  }
  type InferInput<Schema extends StandardSchemaV1> = NonNullable<Schema["~standard"]["types"]>["input"];
  type InferOutput<Schema extends StandardSchemaV1> = NonNullable<Schema["~standard"]["types"]>["output"];
}

/** A JSON Schema document, which refers to its definitions as `#/$defs/<name>`. */
export interface JsonSchema {
  readonly [key: string]: unknown;
}

/** A schema of this package: a Standard Schema whose `validate` reads a value as the schema does, and its JSON Schema, with the definitions it refers to under `$defs`, for embedding in another schema. */
export interface TrileanSchema<T> extends StandardSchemaV1<unknown, T> {
  readonly jsonSchema: JsonSchema;
}

"#;

/// A JSON string literal of the text, which a JavaScript module holds as source.
fn js_text(text: &str) -> String {
    json_shape::Value::String(text.to_owned()).to_string()
}

/// The generated module of the schemas: one frozen Standard Schema object for each schema of `trilean::schemas`, the
/// plain arrays beside them, and nothing that reads a value itself: `validate` hands it to the module.
fn schemas_js(package: &Package) -> String {
    let mut text = format!(
        "import \"#init\";\nimport {{ readSchema }} from \"./{glue}.js\";\n\n",
        glue = package.glue
    );
    text.push_str(
        "function freeze(value) {\n  if (typeof value === \"object\" && value !== null && !Object.isFrozen(value)) {\n    Object.values(value).forEach(freeze);\n    Object.freeze(value);\n  }\n  return value;\n}\n\n",
    );
    text.push_str(&format!(
        "const definitions = freeze(JSON.parse({}));\n\n",
        js_text(&trilean::schemas::definitions_schema().to_string())
    ));
    text.push_str(
        "function schema(name, source) {\n  return Object.freeze({\n    \"~standard\": Object.freeze({\n      version: 1,\n      vendor: \"trilean\",\n      validate: (value) => readSchema(name, value),\n    }),\n    jsonSchema: freeze({ ...JSON.parse(source), $defs: definitions }),\n  });\n}\n\n",
    );
    for schema in trilean::schemas::SCHEMAS {
        let source = trilean::schemas::json_schema_of(schema.name)
            .map(|document| document.to_string())
            .unwrap_or_default();
        text.push_str(&format!(
            "export const {name} = schema({name_text}, {source});\n",
            name = schema.name,
            name_text = js_text(schema.name),
            source = js_text(&source)
        ));
    }
    text.push('\n');
    for (name, _, members) in trilean::schemas::enumerations() {
        let list: Vec<String> = members.iter().map(|member| js_text(member)).collect();
        text.push_str(&format!(
            "export const {name} = Object.freeze([{}]);\n",
            list.join(", ")
        ));
    }
    text
}

/// The declarations of the schemas module: the Standard Schema types, every type of the package, and the type of every
/// exported schema and array.
fn schemas_declarations() -> String {
    let mut text = String::from(STANDARD_SCHEMA_TYPES);
    text.push_str(&trilean::schemas::typescript());
    text.push('\n');
    for schema in trilean::schemas::SCHEMAS {
        text.push_str(&format!(
            "export declare const {}: TrileanSchema<{}>;\n",
            schema.name, schema.type_name
        ));
    }
    text.push('\n');
    for (name, element, _) in trilean::schemas::enumerations() {
        text.push_str(&format!(
            "export declare const {name}: readonly {element}[];\n"
        ));
    }
    text
}

/// The document the package publishes as `schemas/trilean.schema.json`, in RFC 8785 form: the keys sorted at every
/// level, numbers as ECMAScript writes them, and no trailing newline, so the file's bytes are exactly its canonical
/// form and a consumer can re-derive its digest from the parsed content.
fn published_schema(version: &str) -> String {
    let id = format!("https://cdn.jsdelivr.net/npm/trilean@{version}/schemas/trilean.schema.json");
    trilean::schemas::published_document(&id).canonical()
}

/// The version a package manifest declares.
fn manifest_version(package_directory: &Path) -> Result<String, String> {
    let path = package_directory.join("package.json");
    let manifest =
        fs::read_to_string(&path).map_err(|error| format!("{}: {error}", path.display()))?;
    let value: json_shape::Value =
        serde_json::from_str(&manifest).map_err(|error| format!("{}: {error}", path.display()))?;
    value
        .get("version")
        .and_then(json_shape::Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| format!("{} has no version", path.display()))
}

/// Writes the files of a package whose own modules import generated schemas: the `#init` modules, the module of the
/// schemas and its declarations, and the document the package publishes.
fn write_schema_files(package: &Package, dist: &Path) -> Result<Written, String> {
    let read = |name: String| {
        fs::read_to_string(dist.join(&name)).map_err(|error| format!("{name}: {error}"))
    };
    let glue_declarations = read(format!("{}.d.ts", package.glue))?;
    let consumer = consumer_declarations(&glue_declarations);
    let wasm = fs::read(dist.join(format!("{}_bg.wasm", package.glue)))
        .map_err(|error| format!("{}_bg.wasm: {error}", package.glue))?;
    let inline_name = format!("{}_inline.js", package.glue);
    let glue_declarations_name = format!("{}.d.ts", package.glue);
    let files = [
        ("init.node.js", init_node(package)),
        (inline_name.as_str(), inline_module(&wasm)),
        ("init.workerd.js", init_workerd(package)),
        ("init.browser.js", init_browser(package)),
        (glue_declarations_name.as_str(), consumer),
        ("schemas.js", schemas_js(package)),
        ("schemas.d.ts", schemas_declarations()),
    ];
    for (name, contents) in &files {
        fs::write(dist.join(name), contents).map_err(|error| format!("{name}: {error}"))?;
    }
    let package_directory = dist
        .parent()
        .ok_or("the generated directory has no parent")?;
    let published = package_directory.join("schemas");
    fs::create_dir_all(&published).map_err(|error| error.to_string())?;
    fs::write(
        published.join("trilean.schema.json"),
        published_schema(&manifest_version(package_directory)?),
    )
    .map_err(|error| error.to_string())?;
    Ok(Written {
        entry_points: ["init.node.js", "init.workerd.js", "init.browser.js"]
            .map(str::to_owned)
            .into(),
        sizes: vec![
            (format!("{}_bg.wasm", package.glue), wasm.len()),
            (inline_name.clone(), files_len(&files, &inline_name)),
        ],
    })
}

/// Writes the entry point, the `#init` modules and the error classes beside what `wasm-bindgen` wrote.
pub fn write_support_files(
    package: &Package,
    dist: &Path,
    test_hooks: bool,
) -> Result<Written, String> {
    if package.flavour == Flavour::Schemas {
        return write_schema_files(package, dist);
    }
    let read = |name: String| {
        fs::read_to_string(dist.join(&name)).map_err(|error| format!("{name}: {error}"))
    };
    let glue_js = read(format!("{}.js", package.glue))?;
    let glue_declarations = read(format!("{}.d.ts", package.glue))?;
    let consumer = consumer_declarations(&glue_declarations);
    let errors = exported(package.errors_js, &["class"]);
    let wasm = fs::read(dist.join(format!("{}_bg.wasm", package.glue)))
        .map_err(|error| format!("{}_bg.wasm: {error}", package.glue))?;
    let inline_name = format!("{}_inline.js", package.glue);
    let glue_declarations_name = format!("{}.d.ts", package.glue);
    let files = [
        ("errors.js", package.errors_js.to_owned()),
        ("errors.d.ts", package.errors_declarations.to_owned()),
        ("init.node.js", init_node(package)),
        (inline_name.as_str(), inline_module(&wasm)),
        ("init.workerd.js", init_workerd(package)),
        ("init.browser.js", init_browser(package)),
        (glue_declarations_name.as_str(), consumer),
        (
            "index.js",
            index_js(
                package,
                &glue_js,
                &errors,
                if test_hooks {
                    "./init.node.js"
                } else {
                    "#init"
                },
            ),
        ),
        (
            "index.d.ts",
            index_declarations(package, &glue_declarations, &errors),
        ),
    ];
    for (name, contents) in &files {
        fs::write(dist.join(name), contents).map_err(|error| format!("{name}: {error}"))?;
    }
    Ok(Written {
        entry_points: [
            "index.js",
            "index.d.ts",
            "init.node.js",
            "init.workerd.js",
            "init.browser.js",
        ]
        .map(str::to_owned)
        .into(),
        sizes: vec![
            (format!("{}_bg.wasm", package.glue), wasm.len()),
            (inline_name.clone(), files_len(&files, &inline_name)),
        ],
    })
}

/// The length in bytes of the file of that name among the files written.
fn files_len(files: &[(&str, String)], name: &str) -> usize {
    files
        .iter()
        .find(|(file, _)| *file == name)
        .map_or(0, |(_, contents)| contents.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    const GLUE: &str = "export function parseRegex(pattern) {}\nexport class CompiledPattern {}\nexport function registerErrorClasses(a, b) {}\nexport function initSync(module) {}\nexport default function __wbg_init() {}\nfunction notExported() {}\n";
    const DECLARATIONS: &str = "export interface LiteralNode { }\nexport type RegexNode = LiteralNode;\nexport function parseRegex(pattern: string): RegexNode;\nexport class CompiledPattern { }\nexport type InitInput = RequestInfo;\nexport interface InitOutput { }\nexport function initSync(module: SyncInitInput): InitOutput;\nexport default function __wbg_init(): Promise<InitOutput>;\n";

    #[test]
    fn the_entry_point_re_exports_the_api_and_leaves_the_loader_out() {
        let package = Package::named("trilean-regex").expect("package");
        let errors = exported(package.errors_js, &["class"]);
        assert_eq!(
            errors,
            [
                "RegexParseError",
                "UnsupportedConstructError",
                "InternalError",
                "RegexInputError"
            ]
        );
        let index = index_js(package, GLUE, &errors, "#init");
        assert!(index.starts_with("import \"#init\";"));
        assert!(
            index.contains("export { parseRegex, CompiledPattern } from \"./trilean_regex.js\";")
        );
        assert!(!index.contains("initSync"));
        assert!(!index.contains("default"));
        assert!(index.contains(
            "registerErrorClasses(RegexParseError, UnsupportedConstructError, InternalError, RegexInputError);"
        ));
        assert_eq!(index.matches("registerErrorClasses").count(), 2);
    }

    #[test]
    fn the_declarations_name_values_and_types_apart_and_leave_the_loader_out() {
        let package = Package::named("trilean-regex").expect("package");
        let declarations = index_declarations(package, DECLARATIONS, &[]);
        assert!(declarations.contains("export { parseRegex, CompiledPattern } from"));
        assert!(declarations.contains("export type { LiteralNode, RegexNode } from"));
        assert!(!declarations.contains("Init"));
    }

    #[test]
    fn the_copy_the_tests_load_starts_the_module_beside_it_and_not_through_the_package() {
        let package = Package::named("trilean-regex").expect("package");
        let index = index_js(package, GLUE, &[], "./init.node.js");
        assert!(index.starts_with("import \"./init.node.js\";"));
        assert!(!index.contains("#init"));
    }

    #[test]
    fn base64_is_the_standard_padded_encoding() {
        for (bytes, text) in [
            (&b""[..], ""),
            (b"f", "Zg=="),
            (b"fo", "Zm8="),
            (b"foo", "Zm9v"),
            (b"foob", "Zm9vYg=="),
            (b"fooba", "Zm9vYmE="),
            (b"foobar", "Zm9vYmFy"),
            (&[0xFB, 0xFF, 0x00], "+/8A"),
        ] {
            assert_eq!(base64(bytes), text);
        }
    }

    #[test]
    fn the_inline_module_holds_only_the_text() {
        assert_eq!(inline_module(b"foo"), "export const base64 = \"Zm9v\";\n");
    }

    #[test]
    fn a_class_is_freed_once_however_many_times_free_is_called() {
        let package = Package::named("trilean-regex").expect("package");
        let index = index_js(package, GLUE, &[], "#init");
        assert!(index.contains("import { registerErrorClasses, CompiledPattern } from"));
        assert!(index.contains("CompiledPattern.prototype.free = ((free) => function () {"));
        assert!(index.contains("if (this.__wbg_ptr !== 0) {"));
        assert!(index.contains(
            "CompiledPattern.prototype[Symbol.dispose] = CompiledPattern.prototype.free;"
        ));
        assert_eq!(
            index_js(package, "export function f() {}\n", &[], "#init")
                .matches("prototype")
                .count(),
            0
        );
    }

    #[test]
    fn the_declarations_a_consumer_gets_need_neither_the_dom_library_nor_disposable() {
        let source = "export class CompiledPattern {\n  free(): void;\n  [Symbol.dispose](): void;\n  test(input: string): boolean;\n}\n\nexport type InitInput = RequestInfo | URL;\nexport function initSync(module: SyncInitInput): InitOutput;\n";
        let consumer = consumer_declarations(source);
        assert_eq!(
            consumer,
            "export class CompiledPattern {\n  free(): void;\n  test(input: string): boolean;\n}\n"
        );
        for needs in [
            "RequestInfo",
            "URL",
            "WebAssembly",
            "Symbol.dispose",
            "BufferSource",
        ] {
            assert!(!consumer.contains(needs), "{needs}");
        }
    }

    #[test]
    fn the_binding_and_test_only_exports_are_not_part_of_the_api() {
        let package = Package::named("trilean-regex").expect("package");
        let glue = "export function parseRegex() {}\nexport function panicForTesting() {}\nexport function registerErrorClasses() {}\n";
        let index = index_js(package, glue, &[], "#init");
        assert!(index.contains("export { parseRegex } from"));
        assert!(!index.contains("panicForTesting"));
    }

    #[test]
    fn each_init_module_loads_the_module_its_runtime_way() {
        let package = Package::named("trilean-regex").expect("package");
        let node = init_node(package);
        assert!(node.contains("Uint8Array.from(atob(base64)"));
        assert!(!node.contains("node:"));
        assert!(!node.contains("readFileSync") && !node.contains("import.meta"));
        assert!(init_workerd(package).contains("import wasm from \"./trilean_regex_bg.wasm\""));
        assert!(init_browser(package).contains("await init("));
    }
}
