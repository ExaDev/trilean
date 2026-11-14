// expect: a newtype variant of a tagged enum must hold a struct that derives Shape
use json_shape::Shape;

#[derive(Shape)]
#[serde(tag = "kind")]
pub enum Wrong {
    Text(String),
}
