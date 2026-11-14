// expect: named `default` found for struct `json_shape::Path`
// A `Path` carries what one conversion remembers, so only `Shape::from_json` makes one, for one document.
pub fn made() -> json_shape::Path {
    json_shape::Path::default()
}
