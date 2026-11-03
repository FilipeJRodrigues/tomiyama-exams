/**
 * Erro: no cabeçalho do exame de grau (§ 6.4, RN004), a faixa atual é procurada como a faixa
 * com `sort_order` igual ao da faixa-alvo menos 1. A API aceita qualquer ordem única ≥ 0
 * (`PUT /belts/{id}`, RN015), então com ordens 0, 10, 20… nenhuma faixa casa e o cabeçalho
 * fica para sempre "Grau (rumo à Roxa)", mesmo com as faixas carregadas e com o exame
 * trazendo `source_belt_id` (a graduação do aluno ao confirmar a presença).
 * Esperado: "Grau na faixa Verde (rumo à Roxa)", usando a faixa de origem do exame (ou, sem
 * ela, a faixa imediatamente anterior na ordem), como o backend faz em `previous_belt`.
 * Issue: #24
 */
import { describe, expect, it } from 'vitest';

import type { Belt, ExamView } from '../../src/api/types';
import { examTitle } from '../../src/features/exam/examModel';
import { mockBelts } from '../../src/mocks/data';

/** The same belts, with the order numbers spread out (0, 10, 20…), as RN015 allows. */
const spacedBelts: Belt[] = [...mockBelts]
  .sort((a, b) => a.sort_order - b.sort_order)
  .map((belt, index) => ({ ...belt, sort_order: index * 10 }));

function belt(name: string): Belt {
  const found = spacedBelts.find((candidate) => candidate.name === name);
  if (!found) throw new Error(name);
  return found;
}

function stripeExam(sourceBeltId: string | null): ExamView {
  return {
    id: 'exame-1',
    event_id: 'e1',
    student_id: 'a1',
    student_name: 'Élida Ramos',
    target_belt_id: belt('Roxa').id,
    kind: 'STRIPE',
    status: 'IN_PROGRESS',
    decided_by_id: null,
    decided_at: null,
    notes: null,
    created_by: 'x',
    created_at: '2026-11-21T12:00:00+00:00',
    source_belt_id: sourceBeltId,
    source_belt_since: sourceBeltId ? '2025-01-10' : null,
    source_stripes: sourceBeltId ? 0 : null,
  };
}

describe('rn004 título do exame de grau com ordens de faixa espaçadas', () => {
  it('usa a faixa de origem do exame', () => {
    const sheet = { exam: stripeExam(belt('Verde').id), target_belt: belt('Roxa') };
    expect(examTitle(sheet, spacedBelts)).toBe('Grau na faixa Verde (rumo à Roxa)');
  });

  it('sem faixa de origem, usa a faixa imediatamente anterior na ordem', () => {
    const sheet = { exam: stripeExam(null), target_belt: belt('Roxa') };
    expect(examTitle(sheet, spacedBelts)).toBe('Grau na faixa Verde (rumo à Roxa)');
  });
});
