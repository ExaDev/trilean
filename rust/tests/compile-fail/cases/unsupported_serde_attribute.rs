// expect: the serde attribute `alias` is not supported by json_shape::Shape
use json_shape::Shape;

#[derive(Shape)]
pub struct Wrong {
    #[serde(alias = "other")]
    pub name: String,
}
