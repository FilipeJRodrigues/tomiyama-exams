import type { Role } from './types';

/** Fixed ids so the simulated students keep their owners across sessions. */
export const MOCK_USER_IDS: Record<Role, string> = {
  examiner: 'mock-examiner',
  guardian: 'mock-guardian',
};

/** Password that simulates the first login with a temporary password. */
export const MOCK_TEMPORARY_PASSWORD = 'temporaria';

/** Code the simulated sign-up "sends" by e-mail. */
export const MOCK_SIGN_UP_CODE = '123456';

/** Code that simulates an expired one. */
export const MOCK_EXPIRED_CODE = '000000';

/** E-mail that simulates an account that already exists. */
export const MOCK_EXISTING_EMAIL = 'existente@example.com';
