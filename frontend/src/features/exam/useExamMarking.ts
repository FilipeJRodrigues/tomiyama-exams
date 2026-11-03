/**
 * § 6.4 marking (RN006): Certo/Errado saved at once with an optimistic update.
 *
 * - Each item keeps the mark the examiner wants (`pending`) until the API confirms it; the
 *   screen shows it over the API data, with the summary moved to match.
 * - One request per item at a time: a click while the item is on its way only changes the
 *   wanted mark, sent when the answer comes back. So the last click on each item wins and
 *   answers can never arrive out of order for the same item.
 * - Each answer is written into the cached exam (`withSavedAnswer`). Its summary is the
 *   source of truth when no other item was on its way meanwhile; otherwise the exam reloads
 *   once every mark has landed.
 * - A refusal puts the item back as the API has it and keeps the message for the screen,
 *   until the same item is saved (the notice is about the failure, not the current state);
 *   a decided exam or closed event (and the other `reloadsExam` cases) reloads the exam, so
 *   the screen turns read-only.
 * - While a mark is on its way the reload on window focus waits, and a reload already on its
 *   way is cancelled: either would bring a sheet older than the mark. The exam reloads once
 *   every mark has landed.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useRef, useState } from 'react';

import { errorMessage, type ApiClient } from '../../api/client';
import { useApi } from '../../api/context';
import { markAnswer, queryKeys, unmarkAnswer } from '../../api/queries';
import type { AnswerResult, ExamSheet, ExamSheetItem } from '../../api/types';
import {
  answerState,
  reloadsExam,
  withSavedAnswer,
  type MarkState,
  type PendingMarks,
} from './examModel';

/** A mark the API refused, for the notice. */
export interface MarkFailure {
  /** Id of the item: a later save of it takes the notice away. */
  itemId: string;
  /** Description of the item, to say which one. */
  item: string;
  message: string;
}

interface ExamRef {
  eventId: string;
  studentId: string;
}

/** Bookkeeping of one exam, outside React state (read only in callbacks). */
interface ExamMarks {
  /** The mark each item should end with, while it differs from the API or is on its way. */
  wanted: Map<string, MarkState>;
  /** Items with a request on its way. */
  sending: Set<string>;
  /** Two items were on their way at the same time: their summaries may miss each other. */
  overlapped: boolean;
  /** Reload the exam once nothing is on its way (focus, cancelled reload, overlap). */
  reloadWhenIdle: boolean;
}

function examKey({ eventId, studentId }: ExamRef): string {
  return `${eventId}/${studentId}`;
}

function sendMark(
  api: ApiClient,
  exam: ExamRef,
  requirementId: string,
  state: MarkState,
): Promise<AnswerResult> {
  return state === 'unmarked'
    ? unmarkAnswer(api, exam.eventId, exam.studentId, requirementId)
    : markAnswer(api, exam.eventId, exam.studentId, requirementId, state === 'correct');
}

function withPending(
  all: Readonly<Record<string, PendingMarks>>,
  key: string,
  itemId: string,
  state: MarkState | undefined,
): Record<string, PendingMarks> {
  const current = Object.entries(all[key] ?? {}).filter(([id]) => id !== itemId);
  if (state !== undefined) current.push([itemId, state]);
  const others = Object.entries(all).filter(([other]) => other !== key);
  if (current.length > 0) others.push([key, Object.fromEntries(current)]);
  return Object.fromEntries(others);
}

export interface ExamMarking {
  /** Marks not confirmed yet for this exam, by item id. */
  pending: PendingMarks;
  /** Some mark of this exam is on its way. */
  busy: boolean;
  /** Last refused mark of this exam, until dismissed or replaced. */
  failure: MarkFailure | null;
  dismissFailure: () => void;
  /** Save the item as `state` (`unmarked` takes the mark off). */
  mark: (item: ExamSheetItem, state: MarkState) => void;
  /** For `useExamSheet`: `false` while a mark is on its way (the reload comes after). */
  canReloadOnFocus: () => boolean;
}

export function useExamMarking(eventId: string, studentId: string): ExamMarking {
  const api = useApi();
  const queryClient = useQueryClient();
  const key = examKey({ eventId, studentId });
  const [pendingByExam, setPendingByExam] = useState<Readonly<Record<string, PendingMarks>>>({});
  const [failure, setFailure] = useState<{ key: string; failure: MarkFailure } | null>(null);
  const books = useRef(new Map<string, ExamMarks>());

  const booksOf = useCallback((exam: string): ExamMarks => {
    let found = books.current.get(exam);
    if (!found) {
      found = { wanted: new Map(), sending: new Set(), overlapped: false, reloadWhenIdle: false };
      books.current.set(exam, found);
    }
    return found;
  }, []);

  const setPending = useCallback((exam: string, itemId: string, state: MarkState | undefined) => {
    setPendingByExam((all) => withPending(all, exam, itemId, state));
  }, []);

  /** Cancel a reload on its way (it may predate the mark); reload later instead. */
  const holdReload = useCallback(
    async (exam: ExamRef, marks: ExamMarks) => {
      const queryKey = queryKeys.examSheet(exam.eventId, exam.studentId);
      if (queryClient.isFetching({ queryKey, exact: true }) === 0) return;
      marks.reloadWhenIdle = true;
      await queryClient.cancelQueries({ queryKey, exact: true });
    },
    [queryClient],
  );

  const settle = useCallback(
    (exam: ExamRef, marks: ExamMarks) => {
      if (marks.sending.size > 0) return;
      const reload = marks.overlapped || marks.reloadWhenIdle;
      marks.overlapped = false;
      marks.reloadWhenIdle = false;
      if (reload) {
        void queryClient.invalidateQueries({
          queryKey: queryKeys.examSheet(exam.eventId, exam.studentId),
          exact: true,
        });
      }
    },
    [queryClient],
  );

  /** Send the item's wanted mark, and again while a newer click changed it meanwhile. */
  const send = useCallback(
    async (exam: ExamRef, item: ExamSheetItem): Promise<void> => {
      const k = examKey(exam);
      const marks = booksOf(k);
      marks.sending.add(item.id);
      if (marks.sending.size > 1) marks.overlapped = true;
      let state = marks.wanted.get(item.id);
      while (state !== undefined) {
        await holdReload(exam, marks);
        let result: AnswerResult;
        try {
          result = await sendMark(api, exam, item.id, state);
        } catch (error) {
          marks.wanted.delete(item.id);
          setPending(k, item.id, undefined);
          setFailure({
            key: k,
            failure: { itemId: item.id, item: item.description, message: errorMessage(error) },
          });
          if (reloadsExam(error)) marks.reloadWhenIdle = true;
          break;
        }
        setFailure((current) =>
          current?.key === k && current.failure.itemId === item.id ? null : current,
        );
        await holdReload(exam, marks);
        const summary = marks.overlapped ? undefined : result.summary;
        queryClient.setQueryData<ExamSheet>(
          queryKeys.examSheet(exam.eventId, exam.studentId),
          (sheet) => sheet && withSavedAnswer(sheet, item.id, result.answer, summary),
        );
        const wanted = marks.wanted.get(item.id);
        if (wanted === answerState(result.answer)) {
          marks.wanted.delete(item.id);
          setPending(k, item.id, undefined);
          break;
        }
        state = wanted;
      }
      marks.sending.delete(item.id);
      settle(exam, marks);
    },
    [api, booksOf, holdReload, queryClient, setPending, settle],
  );

  const mark = useCallback(
    (item: ExamSheetItem, state: MarkState) => {
      const exam = { eventId, studentId };
      const k = examKey(exam);
      const marks = booksOf(k);
      marks.wanted.set(item.id, state);
      setPending(k, item.id, state);
      if (!marks.sending.has(item.id)) void send(exam, item);
    },
    [booksOf, eventId, send, setPending, studentId],
  );

  const canReloadOnFocus = useCallback(() => {
    const marks = books.current.get(key);
    if (!marks || marks.sending.size === 0) return true;
    marks.reloadWhenIdle = true;
    return false;
  }, [key]);

  const dismissFailure = useCallback(() => {
    setFailure(null);
  }, []);

  const pending = pendingByExam[key] ?? {};
  return {
    pending,
    busy: Object.keys(pending).length > 0,
    failure: failure?.key === key ? failure.failure : null,
    dismissFailure,
    mark,
    canReloadOnFocus,
  };
}
