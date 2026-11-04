/** Values, checks and body of the academy data form (§ 6.6, § 3.7). */
import { describe, expect, it } from 'vitest';

import type { Examiner } from '../../../src/api/types';
import {
  examinerLabel,
  firstInvalidField,
  formValuesOf,
  hasInactiveSensei,
  inactiveSenseiText,
  isFirstUse,
  senseiOptions,
  settingsInputOf,
  storedSenseiLabel,
  validateAcademyForm,
} from '../../../src/features/academy/academyFormModel';
import { makeSettings } from './helpers';

const EXAMINERS: Examiner[] = [
  { id: 'a', email: 'alvaro@example.com', name: 'Álvaro' },
  { id: 'b', email: 'carla@example.com', name: null },
];

const EMPTY = makeSettings({
  academy_name: null,
  sensei_user_id: null,
  certificate_city: null,
  created_at: null,
  updated_at: null,
  sensei: null,
});

describe('academy form values', () => {
  it('start from the stored settings, empty before the first save', () => {
    expect(formValuesOf(makeSettings())).toEqual({
      academyName: 'Associação Tomiyama de Judô',
      senseiId: 'sensei-1',
      certificateCity: 'Araraquara',
    });
    expect(formValuesOf(EMPTY)).toEqual({ academyName: '', senseiId: '', certificateCity: '' });
    expect(isFirstUse(EMPTY)).toBe(true);
    expect(isFirstUse(makeSettings())).toBe(false);
  });
});

describe('sensei labels and options', () => {
  it('names an examiner with the e-mail, or the e-mail alone', () => {
    expect(examinerLabel(EXAMINERS[0]!)).toBe('Álvaro (alvaro@example.com)');
    expect(examinerLabel(EXAMINERS[1]!)).toBe('carla@example.com');
    expect(examinerLabel({ id: 'c', email: 'x@example.com', name: '  ' })).toBe('x@example.com');
  });

  it('names the stored sensei, marking an inactive one', () => {
    const sensei = { id: 's', email: 'sensei@example.com', name: 'Tomiyama', active: true };
    expect(storedSenseiLabel(null)).toBe('Sem sensei');
    expect(storedSenseiLabel(sensei)).toBe('Tomiyama (sensei@example.com)');
    expect(storedSenseiLabel({ ...sensei, active: false })).toBe(
      'Tomiyama (sensei@example.com) (inativo)',
    );
    expect(storedSenseiLabel({ ...sensei, name: null, active: false })).toBe(
      'sensei@example.com (inativo)',
    );
    expect(storedSenseiLabel({ ...sensei, email: null, name: null, active: false })).toBe(
      'Examinador não encontrado (inativo)',
    );
  });

  it('inactive sensei: detected and named in the notice', () => {
    const inactive = makeSettings({
      sensei: { id: 's', email: 'sensei@example.com', name: 'Tomiyama', active: false },
    });
    expect(hasInactiveSensei(inactive)).toBe(true);
    expect(hasInactiveSensei(makeSettings())).toBe(false);
    expect(hasInactiveSensei(EMPTY)).toBe(false);
    expect(inactiveSenseiText(inactive.sensei!)).toBe(
      'O sensei Tomiyama não é mais um examinador ativo e não pode decidir os exames.',
    );
    expect(inactiveSenseiText({ ...inactive.sensei!, name: null, email: null })).toBe(
      'O sensei escolhido não é mais um examinador ativo e não pode decidir os exames.',
    );
  });

  it('lists "Sem sensei" and the examiners in the API order', () => {
    const settings = makeSettings({
      sensei_user_id: 'a',
      sensei: { id: 'a', email: 'alvaro@example.com', name: 'Álvaro', active: true },
    });
    expect(senseiOptions(EXAMINERS, settings, 'a')).toEqual([
      { value: '', label: 'Sem sensei' },
      { value: 'a', label: 'Álvaro (alvaro@example.com)' },
      { value: 'b', label: 'carla@example.com' },
    ]);
  });

  it('keeps the stored sensei missing from the list as an option, once', () => {
    const settings = makeSettings({
      sensei_user_id: 's',
      sensei: { id: 's', email: null, name: null, active: false },
    });
    expect(senseiOptions(EXAMINERS, settings, 's').slice(3)).toEqual([
      { value: 's', label: 'Examinador não encontrado (inativo)' },
    ]);
    // The master picked another one: the stored one stays listed.
    expect(senseiOptions(EXAMINERS, settings, 'a')).toHaveLength(4);
    // A chosen id that the settings no longer know (reloaded meanwhile).
    expect(senseiOptions(EXAMINERS, EMPTY, 'z').at(-1)).toEqual({
      value: 'z',
      label: 'Examinador não encontrado (inativo)',
    });
  });
});

describe('validateAcademyForm', () => {
  const valid = { academyName: 'Academia', senseiId: '', certificateCity: '' };

  it('asks for the name and checks the limits in code points', () => {
    expect(validateAcademyForm(valid)).toEqual({});
    expect(validateAcademyForm({ ...valid, academyName: '  ' })).toEqual({
      academyName: 'Informe o nome da academia.',
    });
    expect(validateAcademyForm({ ...valid, academyName: '🥋'.repeat(255) })).toEqual({});
    expect(validateAcademyForm({ ...valid, academyName: 'x'.repeat(256) })).toEqual({
      academyName: 'Use no máximo 255 caracteres.',
    });
    expect(validateAcademyForm({ ...valid, certificateCity: ` ${'x'.repeat(80)} ` })).toEqual({});
    expect(validateAcademyForm({ ...valid, certificateCity: 'x'.repeat(81) })).toEqual({
      certificateCity: 'Use no máximo 80 caracteres.',
    });
  });

  it('points to the first invalid field in screen order', () => {
    expect(
      firstInvalidField({ certificateCity: 'x', academyName: 'Informe o nome da academia.' }),
    ).toBe('academyName');
    expect(firstInvalidField({})).toBeUndefined();
  });
});

describe('settingsInputOf', () => {
  const values = { academyName: ' Academia ', senseiId: 'a', certificateCity: '  ' };

  it('the master sends his choice; "Sem sensei" is null', () => {
    expect(settingsInputOf(values, { isMaster: true, storedSenseiId: 's' })).toEqual({
      academy_name: 'Academia',
      sensei_user_id: 'a',
      certificate_city: null,
    });
    expect(
      settingsInputOf({ ...values, senseiId: '' }, { isMaster: true, storedSenseiId: 's' })
        .sensei_user_id,
    ).toBeNull();
  });

  it('another examiner resends the stored sensei, whatever the field says', () => {
    expect(settingsInputOf(values, { isMaster: false, storedSenseiId: 's' })).toEqual({
      academy_name: 'Academia',
      sensei_user_id: 's',
      certificate_city: null,
    });
    expect(
      settingsInputOf(values, { isMaster: false, storedSenseiId: null }).sensei_user_id,
    ).toBeNull();
  });
});
