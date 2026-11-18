//! Instants as the ECMAScript date-time string format writes them, read into and written from epoch milliseconds.
//!
//! The forms read are the format's own (ECMA-262, "Date Time String Format"): a date of `YYYY`, `YYYY-MM` or
//! `YYYY-MM-DD`, with a year of four digits or a sign and six, optionally followed by `THH:mm`, `THH:mm:ss` or
//! `THH:mm:ss.sss` and an offset of `Z` or `+HH:mm` or `-HH:mm`. A date alone is UTC. The fraction may have any number
//! of digits, of which the first three count, as engines read it. Three things are refused that a JavaScript engine's
//! `Date.parse` reads: a date and time with no offset, which ECMAScript reads in the host's time zone and a crate with
//! no ambient time zone cannot; the lenient forms outside the format that engines also accept; and a value outside
//! the range of a time value (8.64e15 milliseconds either side of the epoch).

/// The largest magnitude of a time value, in milliseconds.
const MAX_TIME_VALUE: f64 = 8.64e15;

const MS_PER_DAY: i64 = 86_400_000;

struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl Reader<'_> {
    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.at).copied()
    }

    fn eat(&mut self, byte: u8) -> bool {
        if self.peek() == Some(byte) {
            self.at += 1;
            true
        } else {
            false
        }
    }

    fn digits(&mut self, count: usize) -> Option<i64> {
        let mut value = 0_i64;
        for _ in 0..count {
            let digit = self.peek().filter(u8::is_ascii_digit)?;
            value = value * 10 + i64::from(digit - b'0');
            self.at += 1;
        }
        Some(value)
    }
}

fn is_leap(year: i64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

fn days_in_month(year: i64, month: i64) -> i64 {
    match month {
        2 if is_leap(year) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

/// The days from 1970-01-01 to the given proleptic Gregorian date.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let shifted_month = (month + 9) % 12;
    let day_of_year = (153 * shifted_month + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// The proleptic Gregorian date of a count of days from 1970-01-01.
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let shifted = days + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * shifted_month + 2) / 5 + 1;
    let month = if shifted_month < 10 {
        shifted_month + 3
    } else {
        shifted_month - 9
    };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

fn year(reader: &mut Reader<'_>) -> Option<i64> {
    match reader.peek()? {
        sign @ (b'+' | b'-') => {
            reader.at += 1;
            let magnitude = reader.digits(6)?;
            if sign == b'-' {
                // The format has no negative zero year.
                (magnitude != 0).then_some(-magnitude)
            } else {
                Some(magnitude)
            }
        }
        _ => reader.digits(4),
    }
}

/// The epoch milliseconds an instant denotes, or `None` when it is not in the forms this module reads.
pub(crate) fn parse(text: &str) -> Option<f64> {
    let mut reader = Reader {
        bytes: text.as_bytes(),
        at: 0,
    };
    let year = year(&mut reader)?;
    let mut month = 1;
    let mut day = 1;
    if reader.eat(b'-') {
        month = reader.digits(2)?;
        if reader.eat(b'-') {
            day = reader.digits(2)?;
        }
    }
    if !(1..=12).contains(&month) || day < 1 || day > days_in_month(year, month) {
        return None;
    }
    let mut time_ms = 0_i64;
    let mut offset_minutes = 0_i64;
    if reader.eat(b'T') {
        let hour = reader.digits(2)?;
        if !reader.eat(b':') {
            return None;
        }
        let minute = reader.digits(2)?;
        let mut second = 0;
        let mut millisecond = 0;
        if reader.eat(b':') {
            second = reader.digits(2)?;
            if reader.eat(b'.') {
                let start = reader.at;
                let mut place = 100;
                while let Some(digit) = reader.peek().filter(u8::is_ascii_digit) {
                    millisecond += place * i64::from(digit - b'0');
                    place /= 10;
                    reader.at += 1;
                }
                if reader.at == start {
                    return None;
                }
            }
        }
        let end_of_day = hour == 24 && minute == 0 && second == 0 && millisecond == 0;
        if !(hour < 24 || end_of_day) || minute > 59 || second > 59 {
            return None;
        }
        time_ms = ((hour * 60 + minute) * 60 + second) * 1000 + millisecond;
        if !reader.eat(b'Z') {
            let sign = match reader.peek()? {
                b'+' => 1,
                b'-' => -1,
                _ => return None,
            };
            reader.at += 1;
            let offset_hour = reader.digits(2)?;
            if !reader.eat(b':') {
                return None;
            }
            let offset_minute = reader.digits(2)?;
            if offset_hour > 23 || offset_minute > 59 {
                return None;
            }
            offset_minutes = sign * (offset_hour * 60 + offset_minute);
        }
    }
    if reader.at != reader.bytes.len() {
        return None;
    }
    let epoch = days_from_civil(year, month, day) * MS_PER_DAY + time_ms - offset_minutes * 60_000;
    #[allow(
        clippy::cast_precision_loss,
        reason = "a six-digit year is under 2^49 milliseconds, which a double holds exactly"
    )]
    let epoch = epoch as f64;
    (epoch.abs() <= MAX_TIME_VALUE).then_some(epoch)
}

/// The instant `new Date(epoch).toISOString()` writes, or `None` when `epoch` is not a time value (not finite, or
/// beyond the range), which is where that call throws. A fraction of a millisecond is dropped towards zero, as a time
/// value is clipped.
pub(crate) fn format(epoch: f64) -> Option<String> {
    if !epoch.is_finite() || epoch.abs() > MAX_TIME_VALUE {
        return None;
    }
    #[allow(
        clippy::cast_possible_truncation,
        reason = "the value is finite and at most 8.64e15 in magnitude, and the truncation is the clipping of a time value"
    )]
    let epoch = epoch.trunc() as i64;
    let days = epoch.div_euclid(MS_PER_DAY);
    let in_day = epoch.rem_euclid(MS_PER_DAY);
    let (year, month, day) = civil_from_days(days);
    let year_text = if (0..=9999).contains(&year) {
        format!("{year:04}")
    } else if year < 0 {
        format!("-{:06}", -year)
    } else {
        format!("+{year:06}")
    };
    Some(format!(
        "{year_text}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        in_day / 3_600_000,
        in_day / 60_000 % 60,
        in_day / 1000 % 60,
        in_day % 1000
    ))
}

#[cfg(test)]
mod tests {
    use super::{format, parse};

    #[test]
    fn the_forms_of_the_format_are_read_and_written_as_to_iso_string_writes_them() {
        for (text, written) in [
            ("2026-01-01", "2026-01-01T00:00:00.000Z"),
            ("2026", "2026-01-01T00:00:00.000Z"),
            ("2026-02", "2026-02-01T00:00:00.000Z"),
            ("2026-01-01T00:00Z", "2026-01-01T00:00:00.000Z"),
            ("2026-01-01T00:00:00.5Z", "2026-01-01T00:00:00.500Z"),
            ("2026-01-01T00:00:00.1239Z", "2026-01-01T00:00:00.123Z"),
            ("2026-01-01T01:00:00+01:00", "2026-01-01T00:00:00.000Z"),
            ("2026-01-01T00:00:00-05:30", "2026-01-01T05:30:00.000Z"),
            ("2024-02-29T24:00:00Z", "2024-03-01T00:00:00.000Z"),
            ("+275760-09-13T00:00:00.000Z", "+275760-09-13T00:00:00.000Z"),
            ("-271821-04-20T00:00:00.000Z", "-271821-04-20T00:00:00.000Z"),
            ("-000001-01-01T00:00:00Z", "-000001-01-01T00:00:00.000Z"),
            ("1969-12-31T23:59:59.999Z", "1969-12-31T23:59:59.999Z"),
        ] {
            assert_eq!(
                parse(text).and_then(format).as_deref(),
                Some(written),
                "{text}"
            );
        }
    }

    #[test]
    fn a_text_outside_the_format_or_the_range_is_refused() {
        for text in [
            "",
            "not-a-timestamp",
            "2026-13-01T00:00:00Z",
            "2026-01-32",
            "2026-02-29",
            "2026-01-01T25:00:00Z",
            "2026-01-01T24:00:01Z",
            "2026-01-01T00:00:00",
            "2026-01-01t00:00:00z",
            "2026/01/01",
            "Nov 13 2026",
            "-000000-01-01T00:00:00Z",
            "+275760-09-13T00:00:00.001Z",
            "2026-01-01T00:00:00.Z",
            "2026-01-01T00:00:00+0100",
        ] {
            assert_eq!(parse(text), None, "{text}");
        }
    }

    #[test]
    fn epoch_milliseconds_are_clipped_towards_zero_and_refused_beyond_the_range() {
        assert_eq!(format(1.9).as_deref(), Some("1970-01-01T00:00:00.001Z"));
        assert_eq!(format(-1.9).as_deref(), Some("1969-12-31T23:59:59.999Z"));
        assert_eq!(format(8.64e15 + 1.0), None);
        assert_eq!(format(f64::NAN), None);
    }
}
