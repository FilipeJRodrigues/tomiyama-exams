import type { Role } from './types';

/** Fixed ids so the simulated students keep their owners across sessions. */
export const MOCK_USER_IDS: Record<Role, string> = {
  examiner: 'mock-examiner',
  guardian: 'mock-guardian',
};

/**
 * E-mail that signs in as the admin master (groups `admin` and `master`) when the simulated
 * profile is "Examinador"; any other e-mail is a plain examiner.
 */
export const MOCK_MASTER_EMAIL = 'master@example.com';

/** Fixed id of the simulated admin master. */
export const MOCK_MASTER_ID = 'mock-master';

/** Password that simulates the first login with a temporary password. */
export const MOCK_TEMPORARY_PASSWORD = 'temporaria';

/** Code the simulated sign-up "sends" by e-mail. */
export const MOCK_SIGN_UP_CODE = '123456';

/** Code that simulates an expired one. */
export const MOCK_EXPIRED_CODE = '000000';

/** E-mail that simulates an account that already exists. */
export const MOCK_EXISTING_EMAIL = 'existente@example.com';

/** Code the simulated password recovery "sends" by e-mail (`MOCK_EXPIRED_CODE` also applies). */
export const MOCK_RESET_CODE = '123456';

/**
 * E-mail whose password the academy "reset in the Cognito console": its login goes to the
 * recovery code step until a new password is set.
 */
export const MOCK_RESET_REQUIRED_EMAIL = 'redefinir@example.com';
