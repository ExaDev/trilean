// expect: #[shape(property_names)] applies only to a type whose shape is map
use json_shape::Shape;

#[derive(Shape)]
pub struct Wrong {
    #[shape(property_names = "^a$")]
    pub count: u8,
}
