/**
 * Texts of the student's exam history (RN018): the exam as on the exam screen (§ 6.4,
 * `examTitle`), the fallbacks for an event or belt that no longer exists, the accessible name
 * of "Abrir exame" and who decided (same criterion as `deciderName`/`decidedByText`).
 */
import { describe, expect, it } from 'vitest';

import type {
  Belt,
  ExamSheet,
  Examiner,
  SettingsSensei,
  StudentHistoryEntry,
} from '../../../src/api/types';
import { examTitle } from '../../../src/features/exam/examModel';
import {
  EMPTY_HISTORY,
  MISSING_EVENT,
  decisionLabel,
  hasEvent,
  historyDateLabel,
  historyEventName,
  historyExamTitle,
  historyNotes,
  openExamLabel,
  type DeciderNames,
} from '../../../src/features/students/studentHistoryModel';
import { mockBelts } from '../../../src/mocks/data';

function belt(name: string): Belt {
  return mockBelts.find((item) => item.name === name)!;
}

function entry(overrides: Partial<StudentHistoryEntry> = {}): StudentHistoryEntry {
  return {
    event_id: 'evento',
    event_name: 'Exame setembro/2027',
    exam_date: '2027-09-25',
    target_belt_id: belt('Azul').id,
    target_belt_name: 'Azul',
    kind: 'BELT',
    status: 'APPROVED',
    decided_by_id: 'sensei',
    decided_at: '2027-09-25T15:00:00+00:00',
    notes: null,
    created_at: '2027-09-25T12:00:00+00:00',
    source: {
      belt_id: belt('Cinza/Azul').id,
      belt_name: 'Cinza/Azul',
      belt_since: '2027-03-20',
      stripes: 0,
    },
    ...overrides,
  };
}

const EXAMINERS: Examiner[] = [
  { id: 'sensei', email: 'sensei@example.com', name: 'Sensei Ativo' },
  { id: 'sem-nome', email: 'semnome@example.com', name: null },
];
const OLD_SENSEI: SettingsSensei = {
  id: 'antigo',
  email: 'antigo@example.com',
  name: 'Sensei Antigo',
  active: false,
};
const LOADED: DeciderNames = { examiners: EXAMINERS, sensei: OLD_SENSEI, loaded: true };

describe('historyExamTitle (§ 6.4 texts)', () => {
  it.each<[string, Partial<StudentHistoryEntry>, string]>([
    ['belt exam', {}, 'Faixa Azul'],
    [
      'stripe exam with the belt of the stripe',
      {
        kind: 'STRIPE',
        target_belt_name: 'Marrom',
        source: {
          belt_id: belt('Roxa').id,
          belt_name: 'Roxa',
          belt_since: '2025-06-30',
          stripes: 3,
        },
      },
      'Grau na faixa Roxa (rumo à Marrom)',
    ],
    ['stripe exam without source', { kind: 'STRIPE', source: null }, 'Grau (rumo à Azul)'],
    [
      'stripe exam whose source belt is gone',
      {
        kind: 'STRIPE',
        source: { belt_id: 'apagada', belt_name: null, belt_since: '2027-03-20', stripes: 1 },
      },
      'Grau (rumo à Azul)',
    ],
    ['belt exam whose target belt is gone', { target_belt_name: null }, 'Faixa —'],
    ['stripe exam whose target belt is gone', { kind: 'STRIPE', target_belt_name: null }, 'Grau'],
  ])('%s', (_case, overrides, text) => {
    expect(historyExamTitle(entry(overrides))).toBe(text);
  });

  it('gives the same text as the exam screen for the same exam', () => {
    const roxa = belt('Roxa');
    const marrom = belt('Marrom');
    const sheet = {
      exam: { kind: 'STRIPE', source_belt_id: roxa.id },
      target_belt: marrom,
    } as Pick<ExamSheet, 'exam' | 'target_belt'>;
    const history = entry({
      kind: 'STRIPE',
      target_belt_name: marrom.name,
      source: { belt_id: roxa.id, belt_name: roxa.name, belt_since: '2025-06-30', stripes: 3 },
    });
    expect(historyExamTitle(history)).toBe(examTitle(sheet, mockBelts));
    expect(historyExamTitle(entry({ target_belt_name: null }))).toBe(
      examTitle({ ...sheet, exam: { ...sheet.exam, kind: 'BELT' }, target_belt: null }),
    );
  });
});

describe('the event of the exam', () => {
  it('shows its name and date', () => {
    expect(hasEvent(entry())).toBe(true);
    expect(historyEventName(entry())).toBe('Exame setembro/2027');
    expect(historyDateLabel(entry())).toBe('25/09/2027');
  });

  it('says "Evento não encontrado" and "—" when the event is gone', () => {
    const gone = entry({ event_name: null, exam_date: null });
    expect(hasEvent(gone)).toBe(false);
    expect(historyEventName(gone)).toBe(MISSING_EVENT);
    expect(MISSING_EVENT).toBe('Evento não encontrado');
    expect(historyDateLabel(gone)).toBe('—');
  });

  it('has a pt-BR text for an empty history', () => {
    expect(EMPTY_HISTORY).toBe('Nenhum exame registrado.');
  });
});

describe('openExamLabel', () => {
  it('starts with the text on screen and says which exam it opens', () => {
    expect(openExamLabel(entry())).toBe('Abrir exame: Faixa Azul, Exame setembro/2027, 25/09/2027');
    expect(openExamLabel(entry({ kind: 'STRIPE', target_belt_name: 'Marrom', source: null }))).toBe(
      'Abrir exame: Grau (rumo à Marrom), Exame setembro/2027, 25/09/2027',
    );
  });
});

describe('decisionLabel (RN008, criterion of the exam screen)', () => {
  it('is undefined while the exam is in progress', () => {
    expect(
      decisionLabel(
        entry({ status: 'IN_PROGRESS', decided_by_id: null, decided_at: null }),
        LOADED,
      ),
    ).toBeUndefined();
  });

  it('rn008 names an active examiner, else the e-mail', () => {
    expect(decisionLabel(entry(), LOADED)).toEqual({
      who: 'Decidido por Sensei Ativo',
      when: '25/09/2027',
    });
    expect(decisionLabel(entry({ decided_by_id: 'sem-nome' }), LOADED)?.who).toBe(
      'Decidido por semnome@example.com',
    );
  });

  it('rn008 names the sensei of the settings, also when no longer active', () => {
    expect(decisionLabel(entry({ decided_by_id: 'antigo' }), LOADED)?.who).toBe(
      'Decidido por Sensei Antigo',
    );
  });

  it('rn008 says "não está mais ativo" only once both reads answered', () => {
    expect(decisionLabel(entry({ decided_by_id: 'quem-saiu' }), LOADED)?.who).toBe(
      'Decidido por um examinador que não está mais ativo',
    );
    const loading: DeciderNames = { examiners: undefined, sensei: undefined, loaded: false };
    expect(decisionLabel(entry({ decided_by_id: 'quem-saiu' }), loading)?.who).toBe('Decidido');
    expect(decisionLabel(entry(), loading)?.who).toBe('Decidido');
  });

  it('names the sensei from the settings when the examiners failed', () => {
    const noExaminers: DeciderNames = { examiners: undefined, sensei: OLD_SENSEI, loaded: false };
    expect(decisionLabel(entry({ decided_by_id: 'antigo' }), noExaminers)?.who).toBe(
      'Decidido por Sensei Antigo',
    );
  });

  it('gives the day of the decision in the local time zone (UTC-3 in the suite)', () => {
    expect(decisionLabel(entry({ decided_at: '2027-09-26T01:30:00+00:00' }), LOADED)?.when).toBe(
      '25/09/2027',
    );
    expect(decisionLabel(entry({ decided_at: '2027-09-26T03:00:00Z' }), LOADED)?.when).toBe(
      '26/09/2027',
    );
    expect(decisionLabel(entry({ decided_at: null }), LOADED)?.when).toBeUndefined();
    expect(decisionLabel(entry({ decided_at: 'ontem' }), LOADED)?.when).toBeUndefined();
  });
});

describe('historyNotes', () => {
  it('keeps the note and drops a blank one', () => {
    expect(historyNotes(entry({ notes: 'Treinar as quedas' }))).toBe('Treinar as quedas');
    expect(historyNotes(entry({ notes: '   ' }))).toBeUndefined();
    expect(historyNotes(entry({ notes: null }))).toBeUndefined();
  });
});
