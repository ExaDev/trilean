// expect: a flattened field must be a struct that derives Shape
use json_shape::Shape;

#[derive(Shape)]
pub struct Wrong {
    #[serde(flatten)]
    pub inner: Vec<u8>,
}
