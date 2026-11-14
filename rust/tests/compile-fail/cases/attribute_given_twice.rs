// expect: `min` is given twice
use json_shape::Shape;

#[derive(Shape)]
pub struct Wrong {
    #[shape(min = 1, min = 2)]
    pub count: u8,
}
