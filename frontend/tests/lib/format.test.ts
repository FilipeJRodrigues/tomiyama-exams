import { describe, expect, it } from 'vitest';

import { formatPercent } from '../../src/lib/format';

describe('formatPercent', () => {
  it('uses a decimal comma', () => {
    expect(formatPercent(72.5)).toBe('72,5%');
    expect(formatPercent(100)).toBe('100%');
    expect(formatPercent(0)).toBe('0%');
    expect(formatPercent(66.666)).toBe('66,7%');
  });
});
