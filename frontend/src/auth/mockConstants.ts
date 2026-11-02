import type { Role } from './types';

/** Fixed ids so the simulated students keep their owners across sessions. */
export const MOCK_USER_IDS: Record<Role, string> = {
  examiner: 'mock-examiner',
  guardian: 'mock-guardian',
};

/** Password that simulates the first login with a temporary password. */
export const MOCK_TEMPORARY_PASSWORD = 'temporaria';
