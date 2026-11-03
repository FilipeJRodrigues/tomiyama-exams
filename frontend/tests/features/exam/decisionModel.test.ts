/** Texts and roles of the sensei decision (§ 6.4, RN004, RN008). */
import { describe, expect, it } from 'vitest';

import type { ExamSheet, Examiner } from '../../../src/api/types';
import {
  confirmationText,
  decidedByText,
  deciderName,
  decisionAnnouncement,
  decisionRole,
  senseiOnlyText,
} from '../../../src/features/exam/decisionModel';
import { mockBelts } from '../../../src/mocks/data';

const belt = (name: string) => mockBelts.find((item) => item.name === name)!;

function sheet(
  kind: 'BELT' | 'STRIPE',
  target: string | null,
  source: string | null = null,
  name: string | null = 'Ana',
): Pick<ExamSheet, 'exam' | 'student' | 'target_belt'> {
  return {
    exam: {
      kind,
      student_name: name,
      source_belt_id: source ? belt(source).id : null,
    } as ExamSheet['exam'],
    student: name ? { id: 's', full_name: name, birth_date: '2018-05-10' } : null,
    target_belt: target ? belt(target) : null,
  };
}

describe('confirmationText', () => {
  it('rn008 names the student and the target belt of a belt exam', () => {
    expect(confirmationText('APPROVED', sheet('BELT', 'Cinza/Azul'), mockBelts)).toBe(
      'Aprovar Ana para a faixa Cinza/Azul? A decisão não pode ser desfeita.',
    );
    expect(confirmationText('FAILED', sheet('BELT', 'Cinza/Azul'), mockBelts)).toBe(
      'Reprovar Ana no exame da faixa Cinza/Azul? A decisão não pode ser desfeita.',
    );
  });

  it('rn004 names the belt the stripe is earned in', () => {
    expect(confirmationText('APPROVED', sheet('STRIPE', 'Marrom', 'Roxa'), mockBelts)).toBe(
      'Aprovar Ana no exame de grau na faixa Roxa? A decisão não pode ser desfeita.',
    );
    // Older exams without the source belt: the belt right before the target.
    expect(confirmationText('FAILED', sheet('STRIPE', 'Marrom'), mockBelts)).toBe(
      'Reprovar Ana no exame de grau na faixa Roxa? A decisão não pode ser desfeita.',
    );
  });

  it('stays meaningful while the belts load or without the student', () => {
    expect(confirmationText('APPROVED', sheet('STRIPE', 'Marrom'), undefined)).toBe(
      'Aprovar Ana no exame de grau? A decisão não pode ser desfeita.',
    );
    expect(confirmationText('APPROVED', sheet('BELT', null, null, null), mockBelts)).toBe(
      'Aprovar o aluno no exame de faixa? A decisão não pode ser desfeita.',
    );
  });
});

describe('decisionRole', () => {
  const sensei = { id: 'u1', email: 'sensei@example.com', name: 'Tomiyama', active: true };

  it('rn008 lets only the sensei decide, the master included', () => {
    expect(decisionRole({ sensei }, 'u1')).toEqual({ kind: 'sensei' });
    expect(decisionRole({ sensei }, 'master')).toEqual({ kind: 'other', senseiName: 'Tomiyama' });
    expect(decisionRole({ sensei }, undefined)).toEqual({
      kind: 'other',
      senseiName: 'Tomiyama',
    });
  });

  it('rn008 asks for a sensei when there is none or he is inactive', () => {
    expect(decisionRole({ sensei: null }, 'u1')).toEqual({ kind: 'noSensei' });
    expect(decisionRole({ sensei: { ...sensei, active: false } }, 'u1')).toEqual({
      kind: 'inactiveSensei',
    });
  });

  it('falls back to the e-mail, then to no name', () => {
    expect(decisionRole({ sensei: { ...sensei, name: '  ' } }, 'x')).toEqual({
      kind: 'other',
      senseiName: 'sensei@example.com',
    });
    expect(senseiOnlyText(undefined)).toBe('A decisão é do sensei');
    expect(senseiOnlyText('Tomiyama')).toBe('A decisão é do sensei Tomiyama');
  });
});

describe('who decided', () => {
  const examiners: Examiner[] = [{ id: 'u2', email: 'carla@example.com', name: null }];
  const sensei = { id: 'u1', email: 'sensei@example.com', name: 'Tomiyama', active: false };

  it('rn008 names an active examiner, else the sensei of the settings', () => {
    expect(deciderName('u2', examiners, sensei)).toBe('carla@example.com');
    expect(deciderName('u1', examiners, sensei)).toBe('Tomiyama');
    expect(deciderName('u9', examiners, sensei)).toBeUndefined();
    expect(deciderName('u1', undefined, undefined)).toBeUndefined();
  });

  it('uses a neutral text without a name', () => {
    expect(decidedByText('Tomiyama', true)).toBe('Decidido por Tomiyama');
    expect(decidedByText(undefined, true)).toBe(
      'Decidido por um examinador que não está mais ativo',
    );
    expect(decidedByText(undefined, false)).toBe('Decidido');
  });

  it('reads the result out', () => {
    expect(decisionAnnouncement('APPROVED')).toBe('Exame aprovado.');
    expect(decisionAnnouncement('FAILED')).toBe('Exame reprovado.');
  });
});
