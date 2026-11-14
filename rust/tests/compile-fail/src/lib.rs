//! Each file in `cases/` is a construct the `json-shape` derive must refuse. A case is compiled only when the crate
//! is built with `--cfg compile_fail="<file stem>"`, which `sh scripts/rust.sh compile-fail` does once per case,
//! expecting the build to fail with the text the file's `// expect:` line gives. Built without the flag, as every
//! other check builds it, this crate is empty.
//!
//! A case with no line here compiles to nothing, so the check reports it as a case that compiles and fails.

// The cases name the crate; built without a case, nothing does.
use json_shape as _;

#[cfg(compile_fail = "constraint_on_wrong_kind")]
#[path = "../cases/constraint_on_wrong_kind.rs"]
mod constraint_on_wrong_kind;

#[cfg(compile_fail = "property_names_on_integer")]
#[path = "../cases/property_names_on_integer.rs"]
mod property_names_on_integer;

#[cfg(compile_fail = "constant_on_wrong_kind")]
#[path = "../cases/constant_on_wrong_kind.rs"]
mod constant_on_wrong_kind;

#[cfg(compile_fail = "flatten_non_struct")]
#[path = "../cases/flatten_non_struct.rs"]
mod flatten_non_struct;

#[cfg(compile_fail = "tagged_newtype_non_struct")]
#[path = "../cases/tagged_newtype_non_struct.rs"]
mod tagged_newtype_non_struct;

#[cfg(compile_fail = "duplicate_key_through_flatten")]
#[path = "../cases/duplicate_key_through_flatten.rs"]
mod duplicate_key_through_flatten;

#[cfg(compile_fail = "duplicate_key_with_tag")]
#[path = "../cases/duplicate_key_with_tag.rs"]
mod duplicate_key_with_tag;

#[cfg(compile_fail = "pattern_outside_subset")]
#[path = "../cases/pattern_outside_subset.rs"]
mod pattern_outside_subset;

#[cfg(compile_fail = "attribute_at_wrong_position")]
#[path = "../cases/attribute_at_wrong_position.rs"]
mod attribute_at_wrong_position;

#[cfg(compile_fail = "attribute_given_twice")]
#[path = "../cases/attribute_given_twice.rs"]
mod attribute_given_twice;

#[cfg(compile_fail = "unsupported_serde_attribute")]
#[path = "../cases/unsupported_serde_attribute.rs"]
mod unsupported_serde_attribute;

#[cfg(compile_fail = "untagged_two_unit_variants")]
#[path = "../cases/untagged_two_unit_variants.rs"]
mod untagged_two_unit_variants;

#[cfg(compile_fail = "externally_tagged_enum")]
#[path = "../cases/externally_tagged_enum.rs"]
mod externally_tagged_enum;

#[cfg(compile_fail = "generic_type")]
#[path = "../cases/generic_type.rs"]
mod generic_type;

#[cfg(compile_fail = "exclusive_min_on_string")]
#[path = "../cases/exclusive_min_on_string.rs"]
mod exclusive_min_on_string;

#[cfg(compile_fail = "catch_all_in_a_strict_struct")]
#[path = "../cases/catch_all_in_a_strict_struct.rs"]
mod catch_all_in_a_strict_struct;
