/**
 * Exam notices at the top of the student's profile (RN019, § 6.2), for the guardian only: one
 * "Exame de faixas dia dd/mm/aaaa" per item of `GET /students/{id}/exam-notices`, in the API
 * order. They only inform: no action, no link, nothing to edit. Without notices nothing is
 * shown at all. The area loads and fails apart from the form: its error never replaces the
 * form, and the form never waits for it.
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
   * Whether the student's form is on the screen. Only then are the notices asked for and
   * shown: a student that answers 404 is never asked for.
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
  const notices = useStudentExamNotices(studentId, visible);
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
  // (window focus) keeps them on the screen.
  let content: ReactNode;
  if (notices.data === undefined && notices.isError) {
    content = (
      <LoadError
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
