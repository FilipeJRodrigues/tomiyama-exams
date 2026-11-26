/**
 * Texto dos campos numa tela de toque (#191; § 6.7), nas telas que o teste de regressão
 * `tests/regression/191-zoom-campos-tela-de-toque.test.tsx` não abre:
 *
 * - "Defina uma nova senha" do primeiro acesso;
 * - o passo 2 do recuperar senha (Código, Nova senha, Confirme a nova senha);
 * - o código do cadastro ("Confirme seu e-mail");
 * - "Editar aluno";
 * - "Editar faixa" como admin master (todos os campos);
 * - "Editar evento", com a data só leitura;
 * - Academia de um examinador que não é o master, com o seletor do Sensei só leitura.
 *
 * Em cada uma, todo campo de texto ou seletor (focável ou não: desabilitado e só leitura
 * também) tem pelo menos 16 px numa tela de toque, e os que recebem o foco recebem. Com mouse,
 * os mesmos campos continuam com 14 px (o desktop não muda).
 */
import { act, screen, within } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { paths, studentPath } from '../../src/app/navigation';
import { createMockAuth } from '../../src/auth/mockAuth';
import { MOCK_TEMPORARY_PASSWORD } from '../../src/auth/mockConstants';
import { Styles, loadStyles } from '../computedCss';
import { installMockApi } from '../msw-server';
import { renderApp } from '../render';
import { setTouchScreen, setViewportHeight, setViewportWidth } from '../viewport';

/** Ana Souza, aluna do responsável simulado; o examinador edita qualquer aluno. */
const ANA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e01';

/** Inputs sem texto digitado: o Safari não amplia. */
const NOT_TEXT = new Set(['hidden', 'file', 'checkbox', 'radio', 'button', 'submit', 'reset']);

interface Measured {
  name: string;
  px: number;
  focusable: boolean;
}

function textFields(scope: HTMLElement): HTMLElement[] {
  return [...scope.querySelectorAll<HTMLElement>('input, select, textarea')].filter(
    (field) => !(field instanceof HTMLInputElement && NOT_TEXT.has(field.type)) && !field.hidden,
  );
}

function nameOf(field: HTMLElement): string {
  const label = (field as HTMLInputElement).labels?.[0];
  const text = label?.textContent ?? field.getAttribute('aria-label') ?? '(sem rótulo)';
  return text.replace(/\s*\*\s*$/, '').trim();
}

/** Mede cada campo do escopo; os focáveis recebem o foco antes, como um toque. */
async function measure(scope: HTMLElement): Promise<Measured[]> {
  const out: Measured[] = [];
  for (const field of textFields(scope)) {
    const focusable = !(field as HTMLInputElement).disabled && field.tabIndex >= 0;
    if (focusable) {
      act(() => {
        field.focus();
      });
      expect(field).toHaveFocus();
    }
    const styles = await Styles.now();
    out.push({ name: nameOf(field), px: styles.fontSizePx(field), focusable });
  }
  return out;
}

function expectLabels(measured: Measured[], labels: readonly string[]) {
  const names = measured.map((item) => item.name);
  for (const label of labels) expect(names, `falta o campo "${label}"`).toContain(label);
}

interface Screen {
  name: string;
  labels: readonly string[];
  /** Abre a tela e devolve o escopo com os campos. */
  open: () => Promise<HTMLElement>;
}

const SCREENS: Screen[] = [
  {
    name: 'primeiro acesso: "Defina uma nova senha"',
    labels: ['Nova senha', 'Confirme a nova senha'],
    open: async () => {
      const { user } = await renderApp({ route: paths.login });
      await user.type(await screen.findByLabelText(/^E-mail/), 'novo@example.com');
      await user.type(screen.getByLabelText(/^Senha/), MOCK_TEMPORARY_PASSWORD);
      await user.click(screen.getByRole('button', { name: 'Entrar' }));
      await screen.findByRole('heading', { name: 'Defina uma nova senha' }, { timeout: 10000 });
      return screen.getByRole('main');
    },
  },
  {
    name: 'recuperar senha, passo 2',
    labels: ['Código', 'Nova senha', 'Confirme a nova senha'],
    open: async () => {
      const { user } = await renderApp({ route: paths.forgotPassword });
      await user.type(await screen.findByLabelText(/^E-mail/), 'mae@example.com');
      await user.click(screen.getByRole('button', { name: 'Enviar código' }));
      await screen.findByRole('heading', { name: 'Crie uma nova senha' }, { timeout: 10000 });
      return screen.getByRole('main');
    },
  },
  {
    name: 'cadastro, código de confirmação',
    labels: ['Código'],
    open: async () => {
      const { user } = await renderApp({ route: paths.signUp, auth: createMockAuth(null) });
      await user.type(await screen.findByLabelText(/^E-mail/), 'mae@example.com');
      await user.type(screen.getByLabelText(/^Senha/), 'senha-forte-1');
      await user.type(screen.getByLabelText(/^Confirme a senha/), 'senha-forte-1');
      await user.click(screen.getByRole('button', { name: 'Criar conta' }));
      await screen.findByRole('heading', { name: 'Confirme seu e-mail' }, { timeout: 10000 });
      return screen.getByRole('main');
    },
  },
  {
    name: 'Editar aluno',
    labels: [
      'Nome',
      'Faixa atual',
      'Nascimento',
      'Na faixa desde',
      'Graus',
      'Registro na federação',
    ],
    open: async () => {
      await renderApp({ route: studentPath(ANA), signedInAs: 'examiner' });
      await screen.findByRole('heading', { name: 'Editar aluno', level: 1 }, { timeout: 10000 });
      await screen.findByDisplayValue('Ana Souza', undefined, { timeout: 10000 });
      return screen.getByRole('main');
    },
  },
  {
    name: 'Editar faixa como admin master',
    labels: [
      'Idade mínima (anos)',
      'Carência na faixa anterior (meses)',
      'Nome',
      'Ordem',
      'Kyū',
      'Nível',
      'Cor',
      'Cor das pontas',
    ],
    open: async () => {
      const { user } = await renderApp({ route: paths.belts, signedInAs: 'master' });
      await user.click(
        await screen.findByRole('button', { name: 'Editar faixa Amarela' }, { timeout: 10000 }),
      );
      return screen.findByRole('dialog', { name: 'Editar faixa Amarela' });
    },
  },
  {
    name: 'Editar evento, data só leitura',
    labels: ['Nome', 'Data do exame', 'Situação'],
    open: async () => {
      const { user } = await renderApp({ route: paths.events, signedInAs: 'examiner' });
      await user.click(
        await screen.findByRole(
          'button',
          { name: 'Editar evento Exame novembro/2026' },
          { timeout: 10000 },
        ),
      );
      const dialog = await screen.findByRole('dialog', { name: 'Editar evento' });
      expect(within(dialog).getByLabelText('Data do exame')).toHaveAttribute('readonly');
      return dialog;
    },
  },
  {
    name: 'Academia de um examinador que não é o master, Sensei só leitura',
    labels: ['Nome da academia', 'Sensei', 'Cidade do certificado'],
    open: async () => {
      await renderApp({ route: paths.academy, signedInAs: 'examiner' });
      await screen.findByRole('heading', { name: 'Academia', level: 1 }, { timeout: 10000 });
      await screen.findByRole('combobox', { name: /^Sensei/ }, { timeout: 10000 });
      return screen.getByRole('main');
    },
  },
];

beforeAll(loadStyles);

describe('#191 campos das demais telas numa tela de toque (iPhone 14, 390 px)', () => {
  beforeEach(() => {
    installMockApi();
    setViewportWidth(390);
    setViewportHeight(844);
    setTouchScreen(true);
  });

  it.each(SCREENS)('$name: todo campo com pelo menos 16 px', async (item) => {
    const measured = await measure(await item.open());
    expectLabels(measured, item.labels);
    expect(
      measured.filter((field) => field.px < 16).map((field) => `${field.name}: ${field.px} px`),
    ).toEqual([]);
  });

  it('o Sensei só leitura (desabilitado, sem foco) também tem 16 px', async () => {
    const academy = await SCREENS[6]?.open();
    if (!academy) throw new Error('tela da Academia');
    const sensei = within(academy).getByRole('combobox', { name: /^Sensei/ });
    expect(sensei).toBeDisabled();
    expect((await Styles.now()).fontSizePx(sensei)).toBe(16);
  });
});

describe('#191 as mesmas telas com mouse (desktop) continuam com 14 px', () => {
  beforeEach(() => {
    installMockApi();
  });

  it.each(SCREENS)('$name: todo campo com 14 px', async (item) => {
    const measured = await measure(await item.open());
    expectLabels(measured, item.labels);
    expect(
      measured.filter((field) => field.px !== 14).map((field) => `${field.name}: ${field.px} px`),
    ).toEqual([]);
  });
});
