// expect: #[shape(constant = "text")] applies only to a string
use json_shape::Shape;

#[derive(Shape)]
pub struct Wrong {
    #[shape(constant = "x")]
    pub count: u8,
}
