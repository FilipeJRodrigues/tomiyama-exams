/**
 * § 6.4 exam of a student (RN006, card #185): the order of the queue. Inside each category the
 * open items come first and the marked ones after, both in sheet order; a category with every
 * item marked goes to the end of the tab. The order depends on the data only, so it is the
 * same after a reload or when another examiner marks.
 */
import { describe, expect, it } from 'vitest';

import type { ExamSheetItem, RequirementKind } from '../../../src/api/types';
import { groupByCategory } from '../../../src/features/exam/examModel';
import {
  MOVE_DELAY_MS,
  firstOpenItem,
  inQueueOrder,
  moveAnnouncement,
  movedItems,
  queueOrder,
} from '../../../src/features/exam/markQueue';

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

/** Groups of the tab in queue order: `[category, ids]`. */
function tab(items: readonly ExamSheetItem[], kind: RequirementKind = 'THEORY') {
  return groupByCategory(inQueueOrder(items, queueOrder(items)).filter((one) => one.kind === kind));
}

function shape(groups: ReturnType<typeof tab>) {
  return groups.map((group) => [group.category, group.items.map((one) => one.id)]);
}

describe('queue of the exam items (§ 6.4, RN006, #185)', () => {
  it('waits about a second before a marked item moves', () => {
    expect(MOVE_DELAY_MS).toBeGreaterThanOrEqual(800);
    expect(MOVE_DELAY_MS).toBeLessThanOrEqual(1200);
  });

  describe('queueOrder', () => {
    it('rn006 puts the open items first in each category, both parts in sheet order', () => {
      const items = [
        item('1', 'Vocabulário', true),
        item('2', 'Vocabulário', null),
        item('3', 'Vocabulário', false),
        item('4', 'Vocabulário', null),
      ];
      expect(shape(tab(items))).toEqual([['Vocabulário', ['2', '4', '1', '3']]]);
    });

    it('rn006 sends a category with every item marked to the end of the tab', () => {
      const items = [
        item('1', 'Vocabulário', true),
        item('2', 'Histórico', null),
        item('3', 'Vocabulário', false),
        item('4', 'Princípios', null),
        item('5', 'Saudação', true),
      ];
      expect(shape(tab(items))).toEqual([
        ['Histórico', ['2']],
        ['Princípios', ['4']],
        ['Vocabulário', ['1', '3']],
        ['Saudação', ['5']],
      ]);
    });

    it('rn006 keeps the sheet order when nothing is marked or everything is', () => {
      const open = [item('1', 'A', null), item('2', 'B', null), item('3', 'A', null)];
      expect(shape(tab(open))).toEqual([
        ['A', ['1', '3']],
        ['B', ['2']],
      ]);
      const done = [item('1', 'A', true), item('2', 'B', false), item('3', 'A', true)];
      expect(shape(tab(done))).toEqual([
        ['A', ['1', '3']],
        ['B', ['2']],
      ]);
    });

    it('rn006 orders each kind on its own', () => {
      const items = [
        item('1', 'Fundamentos', true, 'PRACTICE'),
        item('2', 'Vocabulário', null),
        item('3', 'Naguewaza', null, 'PRACTICE'),
      ];
      expect(shape(tab(items, 'PRACTICE'))).toEqual([
        ['Naguewaza', ['3']],
        ['Fundamentos', ['1']],
      ]);
      expect(shape(tab(items))).toEqual([['Vocabulário', ['2']]]);
    });

    it('rn006 gives the same order for the same data, whoever marked it', () => {
      const mine = [item('1', 'A', true), item('2', 'A', null), item('3', 'B', null)];
      const reloaded = mine.map((one) => ({
        ...one,
        answer: one.answer && { ...one.answer, marked_by: 'outro', marked_at: '2026-11-21T13:00Z' },
      }));
      expect(queueOrder(reloaded)).toEqual(queueOrder(mine));
    });

    it('takes who counts as open from the caller (an item kept in place)', () => {
      const items = [item('1', 'A', true), item('2', 'A', null)];
      expect(queueOrder(items, (one) => one.id === '1' || one.answer === null)).toEqual(['1', '2']);
    });
  });

  describe('inQueueOrder', () => {
    it('sorts the items by a given order, with items it does not know at the end', () => {
      const items = [item('1', 'A', null), item('2', 'A', null), item('3', 'A', null)];
      expect(inQueueOrder(items, ['3', '1']).map((one) => one.id)).toEqual(['3', '1', '2']);
    });
  });

  describe('movedItems', () => {
    it('lists the items whose place changed, and every item of a category that moved', () => {
      const before = groupByCategory([
        item('1', 'Vocabulário', true),
        item('2', 'Vocabulário', true),
        item('3', 'Histórico', null),
        item('4', 'Princípios', null),
      ]);
      const after = groupByCategory([
        item('3', 'Histórico', null),
        item('1', 'Vocabulário', true),
        item('2', 'Vocabulário', true),
        item('4', 'Princípios', null),
      ]);
      expect([...movedItems(before, after)].sort()).toEqual(['1', '2', '3']);
    });

    it('is empty when nothing moved', () => {
      const groups = groupByCategory([item('1', 'A', null), item('2', 'A', true)]);
      expect(movedItems(groups, groups).size).toBe(0);
    });
  });

  describe('firstOpenItem', () => {
    it('is the first item without a mark, or null when every one is marked', () => {
      expect(firstOpenItem(groupByCategory([item('1', 'A', true), item('2', 'B', null)]))).toBe(
        '2',
      );
      expect(firstOpenItem(groupByCategory([item('1', 'A', true)]))).toBeNull();
    });
  });

  describe('moveAnnouncement', () => {
    it('says what was marked and where it went, and when its category went to the end', () => {
      const before = groupByCategory([
        { ...item('1', 'Naguewaza', true), description: 'Osoto gari' },
        { ...item('2', 'Naguewaza', null), description: 'Deashi barai' },
        item('3', 'Fundamentos', null),
      ]);
      const after = groupByCategory([
        { ...item('2', 'Naguewaza', null), description: 'Deashi barai' },
        { ...item('1', 'Naguewaza', true), description: 'Osoto gari' },
        item('3', 'Fundamentos', null),
      ]);
      expect(moveAnnouncement(before, after, new Set(['1']))).toBe(
        'Osoto gari marcado como certo, movido para o fim de Naguewaza.',
      );

      const done = groupByCategory([
        item('3', 'Fundamentos', null),
        { ...item('2', 'Naguewaza', false), description: 'Deashi barai' },
        { ...item('1', 'Naguewaza', true), description: 'Osoto gari' },
      ]);
      expect(moveAnnouncement(after, done, new Set(['2']))).toBe(
        'Deashi barai marcado como errado, movido para o fim de Naguewaza. ' +
          'Categoria Naguewaza completa, movida para o fim da aba.',
      );
    });

    it('says when an item without its mark goes back among the open ones', () => {
      const before = groupByCategory([
        item('2', 'A', null),
        { ...item('1', 'A', true), description: 'Parar' },
      ]);
      const after = groupByCategory([
        { ...item('1', 'A', null), description: 'Parar' },
        item('2', 'A', null),
      ]);
      expect(moveAnnouncement(before, after, new Set(['1']))).toBe(
        'Parar desmarcado, movido para os itens em aberto de A.',
      );
    });

    it('says nothing when none of the given items moved', () => {
      const groups = groupByCategory([item('1', 'A', null), item('2', 'A', true)]);
      expect(moveAnnouncement(groups, groups, new Set(['2']))).toBe('');
    });
  });
});
