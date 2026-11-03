import { describe, expect, it } from 'vitest';

import type { Belt, ExamSheetItem, ExamView, RequirementKind } from '../../../src/api/types';
import {
  canMark,
  examAgeLabel,
  examDayPath,
  examTitle,
  examinerName,
  groupByCategory,
  markState,
  markedCount,
  neighbors,
  percentLabel,
} from '../../../src/features/exam/examModel';
import { mockBelts } from '../../../src/mocks/data';

function belt(name: string): Belt {
  const found = mockBelts.find((item) => item.name === name);
  if (!found) throw new Error(name);
  return found;
}

function item(
  id: string,
  category: string,
  correct: boolean | null,
  kind: RequirementKind = 'THEORY',
): ExamSheetItem {
  return {
    id,
    belt_id: 'faixa',
    kind,
    category,
    description: `Item ${id}`,
    expected_answer: null,
    sort_order: Number(id),
    answer:
      correct === null
        ? null
        : { requirement_id: id, correct, marked_by: 'x', marked_at: '2026-11-21T12:00:00+00:00' },
  };
}

function exam(studentId: string, name: string | null = studentId): ExamView {
  return {
    id: `exame-${studentId}`,
    event_id: 'e1',
    student_id: studentId,
    target_belt_id: 'alvo',
    kind: 'BELT',
    status: 'IN_PROGRESS',
    decided_by_id: null,
    decided_at: null,
    notes: null,
    created_by: 'x',
    created_at: '2026-11-21T12:00:00+00:00',
    source_belt_id: null,
    source_belt_since: null,
    source_stripes: null,
    student_name: name,
  };
}

describe('exam model (§ 6.4)', () => {
  describe('examTitle', () => {
    it('names a belt exam after the target belt', () => {
      expect(examTitle({ exam: exam('a'), target_belt: belt('Cinza/Azul') }, mockBelts)).toBe(
        'Faixa Cinza/Azul',
      );
    });

    it('names a stripe exam after the belt before the target (rn004)', () => {
      const stripe = { ...exam('a'), kind: 'STRIPE' as const };
      expect(examTitle({ exam: stripe, target_belt: belt('Roxa') }, mockBelts)).toBe(
        'Grau na faixa Verde (rumo à Roxa)',
      );
    });

    it('shows the short stripe label while the belts load', () => {
      const stripe = { ...exam('a'), kind: 'STRIPE' as const };
      expect(examTitle({ exam: stripe, target_belt: belt('Roxa') })).toBe('Grau (rumo à Roxa)');
    });
  });

  describe('groupByCategory', () => {
    const items = [
      item('1', 'Vocabulário', true),
      item('2', 'Histórico', null),
      item('3', 'Vocabulário', null),
      item('4', 'Histórico', false),
    ];

    it('groups in sheet order with marked/total per category', () => {
      expect(
        groupByCategory(items).map((group) => [
          group.category,
          group.items.map((one) => one.id),
          `${group.marked}/${group.total}`,
        ]),
      ).toEqual([
        ['Vocabulário', ['1', '3'], '1/2'],
        ['Histórico', ['2', '4'], '1/2'],
      ]);
    });

    it('keeps only the unmarked items, the counts of the whole category and drops empty groups', () => {
      const all = [...items, item('5', 'Princípios', true)];
      expect(
        groupByCategory(all, true).map((group) => [
          group.category,
          group.items.map((one) => one.id),
          `${group.marked}/${group.total}`,
        ]),
      ).toEqual([
        ['Vocabulário', ['3'], '1/2'],
        ['Histórico', ['2'], '1/2'],
      ]);
    });
  });

  it('counts the marked items and tells the mark of each one', () => {
    const items = [item('1', 'A', true), item('2', 'A', false), item('3', 'A', null)];
    expect(markedCount(items)).toBe(2);
    expect(items.map(markState)).toEqual(['correct', 'wrong', 'unmarked']);
  });

  it('rn007 writes the API percentage in pt-BR and "—" without items of the kind', () => {
    expect(percentLabel({ percent: 72.5 })).toBe('72,5%');
    expect(percentLabel({ percent: 0 })).toBe('0%');
    expect(percentLabel({ percent: 100 })).toBe('100%');
    expect(percentLabel({ percent: null })).toBe('—');
  });

  describe('neighbors', () => {
    const exams = [exam('a'), exam('b'), exam('c')];

    it('gives the previous and next present students', () => {
      const { previous, next } = neighbors(exams, 'b');
      expect([previous?.student_id, next?.student_id]).toEqual(['a', 'c']);
    });

    it('has nothing before the first nor after the last', () => {
      expect(neighbors(exams, 'a').previous).toBeUndefined();
      expect(neighbors(exams, 'c').next).toBeUndefined();
    });

    it('has nothing on either side when the student is not in the list', () => {
      expect(neighbors(exams, 'z')).toEqual({ previous: undefined, next: undefined });
    });
  });

  it('rn006 allows marking only in an exam in progress of an open event', () => {
    expect(canMark({ status: 'IN_PROGRESS' }, { status: 'OPEN' })).toBe(true);
    expect(canMark({ status: 'IN_PROGRESS' }, { status: 'CLOSED' })).toBe(false);
    expect(canMark({ status: 'APPROVED' }, { status: 'OPEN' })).toBe(false);
    expect(canMark({ status: 'FAILED' }, { status: 'OPEN' })).toBe(false);
  });

  it('names the examiner, falls back to the e-mail and to nothing', () => {
    const examiners = [
      { id: 'a', email: 'a@example.com', name: 'Álvaro' },
      { id: 'b', email: 'b@example.com', name: null },
    ];
    expect(examinerName(examiners, 'a')).toBe('Álvaro');
    expect(examinerName(examiners, 'b')).toBe('b@example.com');
    expect(examinerName(examiners, 'c')).toBeUndefined();
  });

  it('links back to the exam day with the event selected', () => {
    expect(examDayPath('e 1')).toBe('/dia-do-exame?evento=e+1');
    expect(examDayPath()).toBe('/dia-do-exame');
  });

  it('rn015 gives the age on the event date, and nothing without the student', () => {
    const event = { exam_date: '2026-11-21' };
    expect(examAgeLabel({ birth_date: '2011-11-21' }, event)).toBe('15 anos');
    expect(examAgeLabel({ birth_date: '2011-11-22' }, event)).toBe('14 anos');
    expect(examAgeLabel(null, event)).toBeUndefined();
    expect(examAgeLabel({ birth_date: 'x' }, event)).toBeUndefined();
  });
});
