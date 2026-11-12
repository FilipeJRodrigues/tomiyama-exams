/**
 * Exam notices at the top of the student's profile (RN019, § 6.2), for the guardian only: one
 * "Exame de faixas dia dd/mm/aaaa" per item of `GET /students/{id}/exam-notices`, in the API
 * order. They only inform: no action, no link, nothing to edit. Without notices nothing is
 * shown at all. The area loads and fails apart from the form: its error never replaces the
 * form, and the form never waits for it.
 *
 * The notices are asked for with the student, so in the usual case the form comes up with them
 * already in place. When they are slower than the student, the form comes first with one short
 * line above it, and an error takes about the room of that line: what the user is filling in
 * moves as little as it can (§ 6.7).
 */
import { Alert, Group, Loader, Stack, Text } from '@mantine/core';
import { IconCalendarEvent } from '@tabler/icons-react';
import { useMemo, useRef, type ReactNode, type RefObject } from 'react';

import { useStudentExamNotices } from '../../api/queries';
import { LoadError } from './screenStates';
import {
  NOTICE_COLOR,
  NOTICES_ERROR,
  NOTICES_LABEL,
  NOTICES_LOADING,
  examNoticeDetail,
  examNoticeTitle,
} from './studentNoticeModel';
import { useRetryFocus } from './useRetryFocus';

/** A long event name (up to 80 characters) wraps instead of being cut (§ 6.7). */
const WRAP = { overflowWrap: 'anywhere' } as const;

interface StudentExamNoticesProps {
  studentId: string;
  /**
   * Shown with the form only. Mounted earlier (while the student loads for the first time), so
   * the notices are asked at the same time as the student; hidden meanwhile, so a 404 of the
   * student never shows the area nor an error of it. The page does not mount it for a student
   * that failed and has not loaded yet: each mount with the notices in error asks for them again.
   */
  visible: boolean;
  /**
   * Where the focus goes after a "Tentar de novo" that brings no notice: the area leaves the
   * screen, so the page title takes it (§ 6.7).
   */
  fallbackFocus: RefObject<HTMLElement | null>;
}

/** Mount only for guardians: the route answers 403 to every examiner (RN019). */
export function StudentExamNotices({ studentId, visible, fallbackFocus }: StudentExamNoticesProps) {
  const notices = useStudentExamNotices(studentId);
  const areaRef = useRef<HTMLDivElement>(null);
  // After "Tentar de novo": the area when it stays on the screen (the notices came), else the
  // page title (no notice: nothing is left of the area).
  const destination = useMemo<RefObject<HTMLElement | null>>(
    () => ({
      get current() {
        return areaRef.current ?? fallbackFocus.current;
      },
    }),
    [fallbackFocus],
  );
  const retryFocus = useRetryFocus([notices], destination);

  if (!visible) return null;

  // An error replaces the notices only while there are none yet: a failed background reload
  // (window focus) keeps them on the screen. Compact: it comes after the retries, with the form
  // already in use below it.
  let content: ReactNode;
  if (notices.data === undefined && notices.isError) {
    content = (
      <LoadError
        compact
        title={NOTICES_ERROR}
        error={notices.error}
        retrying={notices.isFetching}
        onRetry={() => void notices.refetch()}
        retryFocus={retryFocus}
      />
    );
  } else if (notices.data === undefined) {
    // One short line, so the form moves little when the answer comes. No `status`: the notices
    // are secondary to the form, and the page's status is the one of the form ("Carregando
    // aluno…", then "Alterações salvas." on the list); the area says it is busy instead.
    content = (
      <Group gap="xs" wrap="nowrap">
        <Loader size="xs" aria-hidden style={{ flex: 'none' }} />
        <Text size="sm" c="dimmed">
          {NOTICES_LOADING}
        </Text>
      </Group>
    );
  } else if (notices.data.length === 0) {
    return null;
  } else {
    content = notices.data.map((notice) => (
      // A standing notice loaded with the page, not an interruption: `note`, not `alert`.
      <Alert
        key={notice.event_id}
        color={NOTICE_COLOR}
        variant="light"
        role="note"
        icon={<IconCalendarEvent aria-hidden />}
        title={examNoticeTitle(notice)}
      >
        <Text size="sm" style={WRAP}>
          {examNoticeDetail(notice)}
        </Text>
      </Alert>
    ));
  }

  return (
    <Stack
      component="section"
      aria-label={NOTICES_LABEL}
      aria-busy={notices.data === undefined && !notices.isError}
      gap="sm"
      ref={areaRef}
      tabIndex={-1}
      className="mantine-focus-auto"
    >
      {content}
    </Stack>
  );
}
