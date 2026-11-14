//! The `npm <package>` task builds an npm package from the Rust crates, run as `sh scripts/rust.sh xtask npm <package>`: it compiles the package's binding crate to wasm, runs `wasm-bindgen --target web` over it, and writes what makes the one build usable in every runtime (the `#init` modules that differ only in how the `.wasm` is loaded, the error classes and the entry point) into the package's `dist` directory, which is build output and never committed.
//!
//! Every file of `dist` is written here, so the set of files is known, and the package's `exports` and `imports` are checked against it: a path they name that was not written, or a written entry point that they leave out, fails the build.

mod generate;
mod packages;

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};

use packages::Package;

fn main() -> ExitCode {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    match run(&arguments) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("xtask: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run(arguments: &[String]) -> Result<(), String> {
    match arguments {
        [command, name] if command == "npm" => {
            let package = Package::named(name).ok_or_else(|| {
                format!(
                    "no package named {name}; the packages are {}",
                    Package::names().join(", ")
                )
            })?;
            build_npm_package(package)
        }
        _ => Err("usage: cargo xtask npm <package>".to_owned()),
    }
}

/// The repository's `rust` directory, which this crate sits in.
fn rust_directory() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_default()
}

fn command_output(command: &mut Command) -> Result<String, String> {
    let output = command
        .output()
        .map_err(|error| format!("could not run {command:?}: {error}"))?;
    if !output.status.success() {
        return Err(format!("{command:?} failed with {}", output.status));
    }
    String::from_utf8(output.stdout).map_err(|error| error.to_string())
}

fn run_checked(command: &mut Command) -> Result<(), String> {
    let status = command
        .status()
        .map_err(|error| format!("could not run {command:?}: {error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("{command:?} failed with {status}"))
    }
}

/// The version `Cargo.lock` pins for a crate, which the `wasm-bindgen` command line tool must equal: the tool and the library it generates glue for are released together and refuse to work across versions.
fn locked_version(lock: &str, crate_name: &str) -> Option<String> {
    let mut lines = lock.lines();
    while let Some(line) = lines.next() {
        if line == format!("name = \"{crate_name}\"") {
            let version = lines.next()?.strip_prefix("version = \"")?;
            return Some(version.strip_suffix('"')?.to_owned());
        }
    }
    None
}

fn target_directory(rust: &Path) -> PathBuf {
    std::env::var_os("CARGO_TARGET_DIR").map_or_else(|| rust.join("target"), PathBuf::from)
}

fn build_npm_package(package: &Package) -> Result<(), String> {
    let rust = rust_directory();
    let root = rust.parent().ok_or("the rust directory has no parent")?;
    let package_directory = root.join("packages").join(package.name);
    let dist = package_directory.join("dist");

    let lock = fs::read_to_string(rust.join("Cargo.lock")).map_err(|error| error.to_string())?;
    let wanted =
        locked_version(&lock, "wasm-bindgen").ok_or("Cargo.lock does not pin wasm-bindgen")?;
    let found = command_output(Command::new("wasm-bindgen").arg("--version")).map_err(|error| {
        format!("{error}; install it with `sh scripts/rust.sh install-wasm-bindgen`")
    })?;
    if found.trim() != format!("wasm-bindgen {wanted}") {
        return Err(format!(
            "the wasm-bindgen command is `{}`, and Cargo.lock pins {wanted}; install it with `sh scripts/rust.sh install-wasm-bindgen`",
            found.trim()
        ));
    }

    let cargo = std::env::var_os("CARGO").unwrap_or_else(|| "cargo".into());
    run_checked(
        Command::new(cargo)
            .current_dir(&rust)
            .args(["build", "--locked", "--package", package.binding])
            .args(["--target", "wasm32-unknown-unknown", "--release"]),
    )?;

    if dist.exists() {
        fs::remove_dir_all(&dist).map_err(|error| error.to_string())?;
    }
    fs::create_dir_all(&dist).map_err(|error| error.to_string())?;
    let module = target_directory(&rust)
        .join("wasm32-unknown-unknown/release")
        .join(format!("{}.wasm", package.binding.replace('-', "_")));
    run_checked(
        Command::new("wasm-bindgen")
            .args(["--target", "web", "--out-name", package.glue, "--out-dir"])
            .arg(&dist)
            .arg(module),
    )?;
    // The declarations of the module's raw exports are of no use beside the declarations of the glue.
    let raw_declarations = dist.join(format!("{}_bg.wasm.d.ts", package.glue));
    if raw_declarations.exists() {
        fs::remove_file(raw_declarations).map_err(|error| error.to_string())?;
    }

    let written = generate::write_support_files(package, &dist)?;
    check_package_manifest(&package_directory.join("package.json"), &written)?;
    println!(
        "built packages/{}/dist: {}",
        package.name,
        written
            .entry_points
            .iter()
            .cloned()
            .collect::<Vec<_>>()
            .join(", ")
    );
    Ok(())
}

/// The `./dist/...` paths a package manifest names, in `exports`, `imports` and everywhere else it can.
fn dist_paths(manifest: &str) -> BTreeSet<String> {
    let mut paths = BTreeSet::new();
    let mut rest = manifest;
    while let Some(start) = rest.find("\"./dist/") {
        let after = &rest[start + 1..];
        let Some(end) = after.find('"') else { break };
        paths.insert(after[..end].to_owned());
        rest = &after[end + 1..];
    }
    paths
}

/// Checks that the manifest names exactly the entry points that were written: every path it names exists, and every entry point that was written is named.
fn check_package_manifest(path: &Path, written: &generate::Written) -> Result<(), String> {
    let manifest =
        fs::read_to_string(path).map_err(|error| format!("{}: {error}", path.display()))?;
    // `sideEffects` is a promise to every bundler about which modules may be dropped when nothing they export is used. The entry point has effects (it starts the module and registers the error classes), so a list that leaves it out, which is the mistake that is easy to make, makes a bundler drop them and the first call fail. No list is written, and a false one cannot be added.
    if manifest.contains("\"sideEffects\"") {
        return Err(format!(
            "{} has a sideEffects field; the entry point has effects, and a bundler that is told otherwise drops them",
            path.display()
        ));
    }
    let named = dist_paths(&manifest);
    let wanted: BTreeSet<String> = written
        .entry_points
        .iter()
        .map(|file| format!("./dist/{file}"))
        .collect();
    if named == wanted {
        return Ok(());
    }
    Err(format!(
        "{} names {named:?} under dist, and the build wrote the entry points {wanted:?}",
        path.display()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_locked_version_is_the_line_after_the_crate_name() {
        let lock = "[[package]]\nname = \"wasm-bindgen\"\nversion = \"0.2.5\"\n\n[[package]]\nname = \"wasm-bindgen-macro\"\nversion = \"9.9.9\"\n";
        assert_eq!(
            locked_version(lock, "wasm-bindgen").as_deref(),
            Some("0.2.5")
        );
        assert_eq!(
            locked_version(lock, "wasm-bindgen-macro").as_deref(),
            Some("9.9.9")
        );
        assert_eq!(locked_version(lock, "absent"), None);
    }

    #[test]
    fn dist_paths_finds_every_dist_path_whatever_key_names_it() {
        let manifest = r##"{ "types": "./dist/index.d.ts", "imports": { "#init": { "node": "./dist/init.node.js" } }, "files": ["dist"], "x": "./src/a.js" }"##;
        assert_eq!(
            dist_paths(manifest).into_iter().collect::<Vec<_>>(),
            ["./dist/index.d.ts", "./dist/init.node.js"]
        );
    }

    #[test]
    fn a_manifest_that_names_a_path_nothing_wrote_or_leaves_one_out_is_refused() {
        let dir = std::env::temp_dir().join(format!("xtask-test-{}", std::process::id()));
        fs::create_dir_all(&dir).expect("temporary directory");
        let manifest = dir.join("package.json");
        let written = generate::Written {
            entry_points: ["index.js", "init.node.js"].map(str::to_owned).into(),
        };
        fs::write(
            &manifest,
            r#"{ "a": "./dist/index.js", "b": "./dist/init.node.js" }"#,
        )
        .expect("write");
        assert!(check_package_manifest(&manifest, &written).is_ok());
        fs::write(&manifest, r#"{ "a": "./dist/index.js" }"#).expect("write");
        assert!(check_package_manifest(&manifest, &written).is_err());
        fs::write(
            &manifest,
            r#"{ "a": "./dist/index.js", "b": "./dist/init.node.js", "c": "./dist/other.js" }"#,
        )
        .expect("write");
        assert!(check_package_manifest(&manifest, &written).is_err());
        fs::write(
            &manifest,
            r#"{ "sideEffects": false, "a": "./dist/index.js", "b": "./dist/init.node.js" }"#,
        )
        .expect("write");
        assert!(check_package_manifest(&manifest, &written).is_err());
        fs::remove_dir_all(&dir).expect("cleanup");
    }
}
