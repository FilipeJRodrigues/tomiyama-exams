/**
 * Calendar dates (birth date, date on the belt, exam date) travel as `AAAA-MM-DD`
 * and are never converted to the local time zone: `new Date('AAAA-MM-DD')` is
 * midnight UTC, which is the previous day in UTC-3.
 */

export interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function daysInMonth(year: number, month: number): number {
  // Day 0 of the next month is the last day of this month; UTC avoids DST shifts.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Parse `AAAA-MM-DD`, or return null when the text is not a real calendar date. Years run
 * from 1 to 9999, as `date.fromisoformat` in the backend (the year 0000 does not exist).
 */
export function parseIsoDate(value: string): CalendarDate | null {
  const match = ISO_DATE.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1) return null;
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day };
}

function requireDate(value: string): CalendarDate {
  const parsed = parseIsoDate(value);
  if (!parsed) throw new RangeError(`Data inválida: ${value}`);
  return parsed;
}

function pad(value: number, size = 2): string {
  return String(value).padStart(size, '0');
}

/** `2027-03-13` → `13/03/2027`. */
export function formatDate(isoDate: string): string {
  const { year, month, day } = requireDate(isoDate);
  return `${pad(day)}/${pad(month)}/${pad(year, 4)}`;
}

/** Today's calendar day in the user's time zone, as `AAAA-MM-DD`. */
export function todayIso(now: Date = new Date()): string {
  return `${pad(now.getFullYear(), 4)}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * Age in completed years on the reference date (never negative).
 *
 * Someone born on 29/02 completes the year on 01/03 in non-leap years, as in the backend.
 */
export function ageInYears(birthIso: string, referenceIso: string): number {
  const birth = requireDate(birthIso);
  const reference = requireDate(referenceIso);
  let years = reference.year - birth.year;
  if (
    reference.month < birth.month ||
    (reference.month === birth.month && reference.day < birth.day)
  ) {
    years -= 1;
  }
  return Math.max(years, 0);
}
