// expect: a property key is used twice, counting the tag and the flattened fields
use json_shape::Shape;

#[derive(Shape)]
pub struct Inner {
    pub id: String,
}

#[derive(Shape)]
pub struct Wrong {
    #[serde(flatten)]
    pub inner: Inner,
    pub id: String,
}
