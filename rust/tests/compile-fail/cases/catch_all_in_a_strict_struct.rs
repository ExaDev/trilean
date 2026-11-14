// expect: a flattened Map or OpenObject takes the other members, so the struct cannot also deny unknown fields
use json_shape::{Map, Shape};

#[derive(Shape)]
#[serde(deny_unknown_fields)]
pub struct Wrong {
    pub kind: String,
    #[serde(flatten)]
    pub rest: Map<String>,
}
