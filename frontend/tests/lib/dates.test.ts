import { describe, expect, it } from 'vitest';

import { ageInYears, formatDate, parseIsoDate, todayIso } from '../../src/lib/dates';

describe('formatDate', () => {
  it('formats AAAA-MM-DD as dd/mm/aaaa', () => {
    expect(formatDate('2027-03-13')).toBe('13/03/2027');
    expect(formatDate('2018-05-01')).toBe('01/05/2018');
  });

  it('keeps the calendar day in UTC-3 (no shift to the previous day)', () => {
    // The suite runs with TZ=America/Sao_Paulo (vite.config.ts), where
    // `new Date('2027-03-01')` is 28/02/2027 21:00: the bug this function avoids.
    const naive = new Date('2027-03-01');
    expect(naive.getTimezoneOffset()).toBe(180);
    expect(naive.getDate()).toBe(28);
    expect(formatDate('2027-03-01')).toBe('01/03/2027');
    expect(formatDate('2027-01-01')).toBe('01/01/2027');
  });

  it('rejects text that is not a calendar date', () => {
    expect(() => formatDate('13/03/2027')).toThrow(RangeError);
    expect(() => formatDate('2027-02-30')).toThrow(RangeError);
    expect(() => formatDate('2027-13-01')).toThrow(RangeError);
  });
});

describe('parseIsoDate', () => {
  it('accepts 29/02 only in leap years', () => {
    expect(parseIsoDate('2028-02-29')).toEqual({ year: 2028, month: 2, day: 29 });
    expect(parseIsoDate('2027-02-29')).toBeNull();
  });

  it('rejects other formats', () => {
    expect(parseIsoDate('2027-3-1')).toBeNull();
    expect(parseIsoDate('2027-03-01T00:00:00Z')).toBeNull();
    expect(parseIsoDate('')).toBeNull();
  });
});

describe('ageInYears', () => {
  it('counts completed years on the reference date', () => {
    expect(ageInYears('2018-05-10', '2027-03-13')).toBe(8);
    expect(ageInYears('2018-05-10', '2026-05-09')).toBe(7);
    expect(ageInYears('2018-05-10', '2026-05-10')).toBe(8);
  });

  it('completes the year of a 29/02 birth on 01/03 in non-leap years', () => {
    expect(ageInYears('2016-02-29', '2017-02-28')).toBe(0);
    expect(ageInYears('2016-02-29', '2017-03-01')).toBe(1);
    expect(ageInYears('2016-02-29', '2020-02-29')).toBe(4);
  });

  it('is never negative', () => {
    expect(ageInYears('2030-01-01', '2027-03-13')).toBe(0);
  });
});

describe('todayIso', () => {
  it('uses the local calendar day, not the UTC one', () => {
    // 23:30 local time on 01/11/2026 is already 02/11 in UTC when the zone is UTC-3.
    const lateEvening = new Date(2026, 10, 1, 23, 30);
    expect(todayIso(lateEvening)).toBe('2026-11-01');
  });
});
