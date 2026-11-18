// expect: a property key is used twice, counting the tag and the flattened fields
use trilean_json_shape::Shape;

#[derive(Shape)]
#[serde(tag = "kind")]
pub enum Wrong {
    Named { kind: String },
}
