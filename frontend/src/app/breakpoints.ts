import { em } from '@mantine/core';

/**
 * Narrow layout (§ 6.7): below `sm` (48em = 768 px) the menu becomes a drawer and lists
 * become cards. 200% zoom at 1280 px (640 CSS px) lands here.
 */
export const MOBILE_QUERY = `(max-width: ${em(767.98)})`;
