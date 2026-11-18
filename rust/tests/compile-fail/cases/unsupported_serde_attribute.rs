// expect: the serde attribute `alias` is not supported by trilean_json_shape::Shape
use trilean_json_shape::Shape;

#[derive(Shape)]
pub struct Wrong {
    #[serde(alias = "other")]
    pub name: String,
}
