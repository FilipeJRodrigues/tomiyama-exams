import { em } from '@mantine/core';

/**
 * Narrow layout (§ 6.7): below `sm` (48em = 768 px) the menu becomes a drawer and lists
 * become cards. 200% zoom at 1280 px (640 CSS px) lands here.
 */
export const MOBILE_QUERY = `(max-width: ${em(767.98)})`;

/**
 * Exam screen (§ 6.4): from 64em (1024 px) the summary is a column at the right of the items;
 * below it (phone, tablet with the side menu, 200% zoom) it is a bar fixed at the bottom.
 */
export const EXAM_SIDE_SUMMARY_QUERY = `(min-width: ${em(1024)})`;
