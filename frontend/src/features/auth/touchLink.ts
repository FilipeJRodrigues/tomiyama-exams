import { TOUCH_TARGET } from '../exam/touch';

/** § 6.7: a text link of the login screens with a touch target of at least 44 px. */
export const TOUCH_LINK = {
  display: 'inline-flex',
  alignItems: 'center',
  ...TOUCH_TARGET,
} as const;
