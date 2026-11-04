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
 * - A refusal that may pass by itself (`isTransientMarkError`: 409 of a transaction conflict,
 *   429, 503, 504, network) is sent again up to twice, after `MARK_RETRY_DELAYS_MS`, while the
 *   item keeps showing the wanted mark. Each try sends the newest click on the item, and the
 *   item still has one request at a time. Leaving the screen cancels the wait.
 * - A refusal that stays puts the item back as the API has it and keeps the message for the
 *   screen, until the same item is saved (the notice is about the failure, not the current
 *   state). Each exam keeps its own notice: a refusal, a save, a dismiss or a click in one
 *   exam never touches the notice of another (the tries of an exam may end after the examiner
 *   moved to the next student). Each refusal is a new notice (`MarkFailure.id`), read out
 *   again even with the same text. After passing refusals the notice offers "Tentar de novo",
 *   which sends the last mark wanted for the item again; a new click on the item takes that
 *   offer away. When one of those refusals may have been saved anyway (`mayHaveSavedMark`:
 *   504, network…), the exam also reloads once nothing is on its way. A decided exam or closed
 *   event (and the other `reloadsExam` cases) reloads the exam, so the screen turns read-only.
 * - While a mark is on its way the reload on window focus waits, and a reload already on its
 *   way is cancelled: either would bring a sheet older than the mark. The exam reloads once
 *   every mark has landed.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';

import { errorMessage, type ApiClient } from '../../api/client';
import { useApi } from '../../api/context';
import { markAnswer, queryKeys, unmarkAnswer } from '../../api/queries';
import type { AnswerResult, ExamSheet, ExamSheetItem } from '../../api/types';
import {
  answerState,
  isTransientMarkError,
  markOutcomeUnknown,
  mayHaveSavedMark,
  reloadsExam,
  withSavedAnswer,
  type MarkState,
  type PendingMarks,
} from './examModel';
import { MARK_RETRY_DELAYS_MS, waitForRetry } from './markRetry';

/** A mark the API refused, for the notice. */
export interface MarkFailure {
  /**
   * Each refusal has its own: the notice is read out again for a new one with the same text
   * (another refusal of the same item or of another), never twice for the same one.
   */
  id: number;
  /** Id of the item: a later save of it takes the notice away. */
  itemId: string;
  /** Description of the item, to say which one. */
  item: string;
  message: string;
  /**
   * The last mark wanted for the item, when the refusal may pass by itself: "Tentar de novo"
   * sends it again. Undefined for a final refusal, or once the item was clicked again.
   */
  retry?: MarkState;
  /**
   * The last try ran out with an unknown outcome and some try of the series may have been
   * saved anyway (network, 504: `markOutcomeUnknown`). The exam reloads and the item may
   * show the mark: the notice says it could not be confirmed, not that it was not saved.
   */
  outcomeUnknown: boolean;
  /**
   * The refusal says the screen is out of date (`reloadsExam`: decided exam, closed event…):
   * the exam reloads and may turn read-only because of this very mark.
   */
  outdated: boolean;
}

/** What a mark needs of the item: which one, and its name for the notice. */
export type MarkItem = Pick<ExamSheetItem, 'id' | 'description'>;

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
  /** Last refused mark of this exam, until dismissed or replaced by another of this exam. */
  failure: MarkFailure | null;
  dismissFailure: () => void;
  /** "Tentar de novo": take the notice away and send `failure.retry` again. */
  retryFailure: () => void;
  /** Save the item as `state` (`unmarked` takes the mark off). */
  mark: (item: MarkItem, state: MarkState) => void;
  /** For `useExamSheet`: `false` while a mark is on its way (the reload comes after). */
  canReloadOnFocus: () => boolean;
}

type FailureUpdate = (current: MarkFailure | undefined) => MarkFailure | undefined;

function withFailure(
  all: Readonly<Record<string, MarkFailure>>,
  key: string,
  update: FailureUpdate,
): Readonly<Record<string, MarkFailure>> {
  const current = all[key];
  const next = update(current);
  if (next === current) return all;
  const others = Object.entries(all).filter(([other]) => other !== key);
  if (next !== undefined) others.push([key, next]);
  return Object.fromEntries(others);
}

export function useExamMarking(eventId: string, studentId: string): ExamMarking {
  const api = useApi();
  const queryClient = useQueryClient();
  const key = examKey({ eventId, studentId });
  const [pendingByExam, setPendingByExam] = useState<Readonly<Record<string, PendingMarks>>>({});
  // The notice of each exam, by exam key: shown only while that exam is on the screen.
  const [failures, setFailures] = useState<Readonly<Record<string, MarkFailure>>>({});
  const books = useRef(new Map<string, ExamMarks>());
  const lastFailureId = useRef(0);
  // Aborted when the screen leaves: a wait before a new try ends there, and the answers that
  // still come back no longer touch the screen state.
  const alive = useRef(new AbortController());

  useEffect(() => {
    const controller = new AbortController();
    alive.current = controller;
    return () => {
      controller.abort();
    };
  }, []);

  const booksOf = useCallback((exam: string): ExamMarks => {
    let found = books.current.get(exam);
    if (!found) {
      found = { wanted: new Map(), sending: new Set(), overlapped: false, reloadWhenIdle: false };
      books.current.set(exam, found);
    }
    return found;
  }, []);

  const setPending = useCallback((exam: string, itemId: string, state: MarkState | undefined) => {
    if (alive.current.signal.aborted) return;
    setPendingByExam((all) => withPending(all, exam, itemId, state));
  }, []);

  /** Change the notice of one exam only. */
  const updateFailure = useCallback((exam: string, update: FailureUpdate) => {
    if (alive.current.signal.aborted) return;
    setFailures((all) => withFailure(all, exam, update));
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

  /**
   * Send the item's wanted mark, and again while a newer click changed it meanwhile. A
   * passing refusal is sent again after each wait of `MARK_RETRY_DELAYS_MS`, with the newest
   * click on the item.
   */
  const send = useCallback(
    async (exam: ExamRef, item: MarkItem): Promise<void> => {
      const k = examKey(exam);
      const marks = booksOf(k);
      const signal = alive.current.signal;
      marks.sending.add(item.id);
      if (marks.sending.size > 1) marks.overlapped = true;
      let state = marks.wanted.get(item.id);
      // Refusals in a row of the current mark; a saved mark starts over.
      let refused = 0;
      // One of those refusals may have been saved anyway (504, network…): reload at the end.
      let unsure = false;
      // One of them had no answer at all (network, 504): the notice cannot say "not saved".
      let unknown = false;
      while (state !== undefined) {
        await holdReload(exam, marks);
        let result: AnswerResult;
        try {
          result = await sendMark(api, exam, item.id, state);
        } catch (error) {
          const transient = isTransientMarkError(error);
          if (mayHaveSavedMark(error)) unsure = true;
          if (markOutcomeUnknown(error)) unknown = true;
          const delay = transient ? MARK_RETRY_DELAYS_MS[refused] : undefined;
          if (delay !== undefined) {
            refused += 1;
            if (!(await waitForRetry(delay, signal))) {
              // The screen left during the wait: nothing more is sent.
              marks.wanted.delete(item.id);
              marks.sending.delete(item.id);
              return;
            }
            // The newest click on the item, made during the wait.
            state = marks.wanted.get(item.id);
            continue;
          }
          const last = marks.wanted.get(item.id) ?? state;
          marks.wanted.delete(item.id);
          setPending(k, item.id, undefined);
          lastFailureId.current += 1;
          const failure: MarkFailure = {
            id: lastFailureId.current,
            itemId: item.id,
            item: item.description,
            message: errorMessage(error),
            retry: transient ? last : undefined,
            // Only while the last refusal itself may pass: a final one says what happened.
            outcomeUnknown: transient && unknown,
            outdated: reloadsExam(error),
          };
          updateFailure(k, () => failure);
          // After a refusal that may have been saved, the cache may be behind the API: the
          // exam reloads once nothing is on its way.
          if (unsure || reloadsExam(error)) marks.reloadWhenIdle = true;
          break;
        }
        refused = 0;
        unsure = false;
        unknown = false;
        updateFailure(k, (current) => (current?.itemId === item.id ? undefined : current));
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
    [api, booksOf, holdReload, queryClient, setPending, settle, updateFailure],
  );

  const mark = useCallback(
    (item: MarkItem, state: MarkState) => {
      const exam = { eventId, studentId };
      const k = examKey(exam);
      const marks = booksOf(k);
      marks.wanted.set(item.id, state);
      setPending(k, item.id, state);
      // The new click is what counts: "Tentar de novo" of this item has nothing left to send.
      updateFailure(k, (current) =>
        current?.itemId === item.id && current.retry !== undefined
          ? { ...current, retry: undefined }
          : current,
      );
      if (!marks.sending.has(item.id)) void send(exam, item);
    },
    [booksOf, eventId, send, setPending, studentId, updateFailure],
  );

  const canReloadOnFocus = useCallback(() => {
    const marks = books.current.get(key);
    if (!marks || marks.sending.size === 0) return true;
    marks.reloadWhenIdle = true;
    return false;
  }, [key]);

  const dismissFailure = useCallback(() => {
    updateFailure(key, () => undefined);
  }, [key, updateFailure]);

  const shown = failures[key] ?? null;

  const retryFailure = useCallback(() => {
    if (shown?.retry === undefined) return;
    updateFailure(key, () => undefined);
    mark({ id: shown.itemId, description: shown.item }, shown.retry);
  }, [key, mark, shown, updateFailure]);

  const pending = pendingByExam[key] ?? {};
  return {
    pending,
    busy: Object.keys(pending).length > 0,
    failure: shown,
    dismissFailure,
    retryFailure,
    mark,
    canReloadOnFocus,
  };
}
