// expect: trilean_json_shape::Shape does not support generic types
use trilean_json_shape::Shape;

#[derive(Shape)]
pub struct Wrong<T> {
    pub inner: T,
}
