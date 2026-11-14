// expect: #[shape(exclusive_min)] applies only to a type whose shape is integer or number
use json_shape::Shape;

#[derive(Shape)]
pub struct Wrong {
    #[shape(exclusive_min = 0)]
    pub name: String,
}
