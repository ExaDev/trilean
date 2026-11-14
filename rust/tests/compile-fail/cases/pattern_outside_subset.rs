// expect: is not supported: a second quantifier, a lazy quantifier and counted repetition are not supported
use json_shape::Shape;

#[derive(Shape)]
pub struct Wrong {
    #[shape(pattern = "a{2}")]
    pub name: String,
}
