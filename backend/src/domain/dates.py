"""Calendar-date helpers.

Dates without time (birth, belt since, exam date) are calendar days stored as
ISO strings ``YYYY-MM-DD`` and never converted between time zones.
"""

import calendar
from datetime import UTC, date, datetime, timedelta, timezone

# Brazil has had no daylight saving time since 2019, so a fixed offset is exact.
BRAZIL_TZ = timezone(timedelta(hours=-3))


def today() -> date:
    """Return the current calendar date in Brazil (UTC-3)."""
    return datetime.now(BRAZIL_TZ).date()


def utc_now_iso() -> str:
    """Return the current UTC timestamp as an ISO 8601 string."""
    return datetime.now(UTC).isoformat(timespec="seconds")


def full_years(birth: date, reference: date) -> int:
    """Return the age in completed years on the reference date.

    Args:
        birth: Date of birth.
        reference: Date on which the age is evaluated.

    Returns:
        Number of completed years (never negative).
    """
    years = reference.year - birth.year
    if (reference.month, reference.day) < (birth.month, birth.day):
        years -= 1
    return max(years, 0)


def full_months(start: date, reference: date) -> int:
    """Return the number of completed months between two dates.

    A month is complete when the reference day reaches the start day. When the
    reference is the last day of a shorter month (e.g. 31/01 -> 28/02), the
    month counts as complete.

    Args:
        start: Initial date.
        reference: Date on which the interval is evaluated.

    Returns:
        Number of completed months (never negative).
    """
    if reference < start:
        return 0
    months = (reference.year - start.year) * 12 + reference.month - start.month
    last_day = calendar.monthrange(reference.year, reference.month)[1]
    if reference.day < start.day and reference.day != last_day:
        months -= 1
    return max(months, 0)
