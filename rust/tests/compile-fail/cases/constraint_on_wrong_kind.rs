// expect: #[shape(min)] applies only to a type whose shape is integer or number
use trilean_json_shape::Shape;

#[derive(Shape)]
pub struct Wrong {
    #[shape(min = 1)]
    pub name: String,
}
