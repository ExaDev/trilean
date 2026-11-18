// expect: trilean_json_shape::Shape does not support externally tagged enums
use trilean_json_shape::Shape;

#[derive(Shape)]
pub enum Wrong {
    Number(u8),
    Nothing,
}
