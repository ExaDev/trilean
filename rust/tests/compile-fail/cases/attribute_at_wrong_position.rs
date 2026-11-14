// expect: `strict` does not apply to a named field
use json_shape::Shape;

#[derive(Shape)]
pub struct Wrong {
    #[shape(strict)]
    pub name: String,
}
