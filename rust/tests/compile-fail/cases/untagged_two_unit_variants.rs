// expect: an untagged enum can have one unit variant, which is null
use json_shape::Shape;

#[derive(Shape)]
#[serde(untagged)]
pub enum Wrong {
    First,
    Second,
}
