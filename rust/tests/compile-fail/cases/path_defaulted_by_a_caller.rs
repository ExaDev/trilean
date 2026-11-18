// expect: named `default` found for struct `trilean_json_shape::Path`
// A `Path` carries what one conversion remembers, so only `Shape::from_json` makes one, for one document.
pub fn made() -> trilean_json_shape::Path {
    trilean_json_shape::Path::default()
}
