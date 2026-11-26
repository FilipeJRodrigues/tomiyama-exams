/**
 * Erro: num iPhone 14 com Safari, toda vez que o responsável entra no sistema, a página
 * seguinte (por exemplo, Academia) aparece ampliada, com o texto maior e cortado nas bordas,
 * e é preciso tirar o zoom com os dedos. O Safari do iOS amplia a página sozinho quando o
 * foco vai para um campo (`input`, `select`, `textarea`) com texto menor que 16 px, e o zoom
 * continua depois da navegação. Os campos do Mantine têm 14 px (`--input-fz` do tamanho
 * `sm`): o e-mail e a senha do login disparam o zoom, e o mesmo acontece em todo formulário
 * (aluno, evento, academia, faixas, requisitos, decisão do exame, telas de entrada).
 * Esperado: depois de entrar, a página na largura da tela, sem zoom (§ 6.7, referência de
 * 390 px). Numa tela de toque, o elemento que recebe o foco em cada campo (`TextInput`, o
 * `input` interno do `PasswordInput`, o `select` do `NativeSelect`, `Textarea`) tem texto de
 * pelo menos 16 px. No desktop os campos podem continuar como estão. Nunca `maximum-scale`
 * nem `user-scalable=no` no `viewport`: no Android isso impede o zoom com os dedos, que o
 * § 6.7 (zoom de 200%) exige.
 * Issue: #191
 *
 * Como o teste mede: a tela de toque vem de `setTouchScreen` (`tests/viewport.ts`), que faz
 * `(hover: none)`, `(any-hover: none)`, `(pointer: coarse)` e `(any-pointer: coarse)`
 * verdadeiros e `(hover: hover)` e `(pointer: fine)` falsos, no `matchMedia` (o JS do app) e no
 * CSS (`tests/computedCss.ts` pergunta ao mesmo stub), além de `navigator.maxTouchPoints`.
 * Vale qualquer jeito razoável de detectar o toque. Em cada tela real, cada campo recebe o
 * foco e o tamanho de texto calculado dele (`Styles.fontSizePx`: a regra que vence a cascata,
 * herança, `var()`, `calc()`, `rem`) é comparado com 16 px; não importa a media query, o
 * seletor nem a variável da correção. Roda no iPhone 14 em pé (390 px) e deitado (844 px): uma
 * correção só por largura de tela deixaria o zoom no celular deitado.
 *
 * Fora do teste: o `<input type="file">` dos logos (Academia), que fica escondido (`hidden`,
 * `tabIndex={-1}`), nunca recebe o foco e não é campo de texto; caixas de seleção, rádios e
 * chaves (sem texto digitado, o Safari não amplia).
 */
import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { examPath, paths } from '../../src/app/navigation';
import { MOCK_USER_IDS } from '../../src/auth/mockConstants';
import { MOCK_EVENT_IDS, createMockDb } from '../../src/mocks/data';
import { createHandlers } from '../../src/mocks/handlers';
import indexHtml from '../../index.html?raw';
import { Styles, loadStyles } from '../computedCss';
import { TEST_API_URL, installMockApi, server } from '../msw-server';
import { renderApp, type RenderAppResult } from '../render';
import { mediaMatches, setTouchScreen, setViewportHeight, setViewportWidth } from '../viewport';

/** Below this, iOS Safari zooms into the field that gets the focus. */
const MIN_FIELD_PX = 16;

const KINDS = ['TextInput', 'PasswordInput', 'NativeSelect', 'Textarea'] as const;
type Kind = (typeof KINDS)[number];

interface Expected {
  label: string;
  kind: Kind;
}

/** The phone of the report, in both orientations (CSS px). */
const DEVICES = [
  { name: 'iPhone 14 em pé', width: 390, height: 844 },
  { name: 'iPhone 14 deitado', width: 844, height: 390 },
] as const;

/** Inputs without typed text: the Safari does not zoom into them. */
const NOT_TEXT = new Set([
  'hidden',
  'file',
  'checkbox',
  'radio',
  'button',
  'submit',
  'reset',
  'image',
  'range',
  'color',
]);

/** Helena's exam is ready for the decision (`includeShowcase`); the date is the event's. */
const HELENA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e08';

/** Fields a person can focus: they take text or a choice from the system picker. */
function focusableFields(scope: HTMLElement): HTMLElement[] {
  return [...scope.querySelectorAll<HTMLElement>('input, select, textarea')].filter((field) => {
    if (field instanceof HTMLInputElement && NOT_TEXT.has(field.type)) return false;
    if (field.hidden || field.tabIndex < 0) return false;
    return !(field as HTMLInputElement).disabled;
  });
}

function kindOf(field: Element): Kind | null {
  return KINDS.find((kind) => field.closest(`.mantine-${kind}-root`)) ?? null;
}

/** The visible label without the required mark, or the `aria-label`. */
function nameOf(field: HTMLElement): string {
  const label = (field as HTMLInputElement).labels?.[0];
  const text = label?.textContent ?? field.getAttribute('aria-label') ?? '(sem rótulo)';
  return text.replace(/\s*\*\s*$/, '').trim();
}

function tagOf(field: HTMLElement): string {
  const type = field instanceof HTMLInputElement ? ` type="${field.type}"` : '';
  return `<${field.tagName.toLowerCase()}${type}>`;
}

function pxText(px: number): string {
  return `${String(Math.round(px * 100) / 100).replace('.', ',')} px`;
}

/**
 * Focuses every field of the scope, as a tap would, and measures the text of the element that
 * got the focus. Fails if a field is missing, of another kind, or under 16 px.
 */
async function expectNoZoom(scope: HTMLElement, where: string, expected: readonly Expected[]) {
  const fields = focusableFields(scope);
  const measured: { name: string; kind: Kind | null; line: string; px: number }[] = [];
  for (const field of fields) {
    act(() => {
      field.focus();
    });
    expect(field, `${where}: o campo "${nameOf(field)}" deveria receber o foco`).toHaveFocus();
    const styles = await Styles.now();
    const px = styles.fontSizePx(field);
    const name = nameOf(field);
    const kind = kindOf(field);
    measured.push({
      name,
      kind,
      px,
      line: `"${name}" (${kind ?? 'outro'}, ${tagOf(field)}): ${pxText(px)}`,
    });
  }
  for (const want of expected) {
    expect(
      measured.some((item) => item.name === want.label && item.kind === want.kind),
      `${where}: falta o campo "${want.label}" (${want.kind}); medidos: ${measured.map((item) => item.line).join('; ')}`,
    ).toBe(true);
  }
  expect(
    measured.filter((item) => item.px < MIN_FIELD_PX).map((item) => item.line),
    `${where}: campos com texto abaixo de ${String(MIN_FIELD_PX)} px numa tela de toque (o Safari do iOS amplia a página ao tocar neles)`,
  ).toEqual([]);
}

async function openPage(
  options: Parameters<typeof renderApp>[0],
  title: string,
): Promise<RenderAppResult> {
  const rendered = await renderApp(options);
  await screen.findByRole('heading', { name: title, level: 1 }, { timeout: 10000 });
  return rendered;
}

function main(): HTMLElement {
  return screen.getByRole('main');
}

describe.each(DEVICES)('#191 campos sem zoom ao tocar: $name ($width px, § 6.7)', (device) => {
  const where = (screenName: string) => `${screenName} (${device.name})`;

  beforeAll(loadStyles);

  beforeEach(() => {
    setViewportWidth(device.width);
    setViewportHeight(device.height);
    setTouchScreen(true);
  });

  it('a simulação é de uma tela de toque', () => {
    for (const query of [
      '(hover: none)',
      '(any-hover: none)',
      '(pointer: coarse)',
      '(any-pointer: coarse)',
      '(hover: none) and (pointer: coarse)',
    ]) {
      expect(window.matchMedia(query).matches, query).toBe(true);
    }
    for (const query of ['(hover: hover)', '(pointer: fine)', '(any-pointer: fine)']) {
      expect(window.matchMedia(query).matches, query).toBe(false);
    }
    expect(mediaMatches(`(max-width: ${String(device.width)}px)`)).toBe(true);
    expect(navigator.maxTouchPoints).toBeGreaterThan(0);
  });

  describe('telas de entrada', () => {
    beforeEach(() => {
      installMockApi();
    });

    it('login: e-mail e senha (a causa do relato)', async () => {
      await openPage({ route: paths.login }, 'Entrar');
      await expectNoZoom(main(), where('Login'), [
        { label: 'E-mail', kind: 'TextInput' },
        { label: 'Senha', kind: 'PasswordInput' },
      ]);
    });

    it('cadastro: e-mail, senha e confirmação', async () => {
      await openPage({ route: paths.signUp }, 'Cadastre-se');
      await expectNoZoom(main(), where('Cadastro'), [
        { label: 'E-mail', kind: 'TextInput' },
        { label: 'Senha', kind: 'PasswordInput' },
        { label: 'Confirme a senha', kind: 'PasswordInput' },
      ]);
    });

    it('recuperar senha: e-mail', async () => {
      await openPage({ route: paths.forgotPassword }, 'Recuperar senha');
      await expectNoZoom(main(), where('Recuperar senha'), [
        { label: 'E-mail', kind: 'TextInput' },
      ]);
    });
  });

  describe('formulários das telas e diálogos', () => {
    beforeEach(() => {
      installMockApi();
    });

    it('Academia (a tela do relato): nome, sensei e cidade', async () => {
      await openPage({ route: paths.academy, signedInAs: 'master' }, 'Academia');
      await screen.findByRole('textbox', { name: /^Nome da academia/ }, { timeout: 10000 });
      await expectNoZoom(main(), where('Academia'), [
        { label: 'Nome da academia', kind: 'TextInput' },
        { label: 'Sensei', kind: 'NativeSelect' },
        { label: 'Cidade do certificado', kind: 'TextInput' },
      ]);
    });

    it('Novo aluno: texto, datas e seletores', async () => {
      await openPage({ route: paths.studentNew, signedInAs: 'examiner' }, 'Novo aluno');
      await screen.findByRole('textbox', { name: /^Nome/ }, { timeout: 10000 });
      await expectNoZoom(main(), where('Novo aluno'), [
        { label: 'Nome', kind: 'TextInput' },
        { label: 'Faixa atual', kind: 'NativeSelect' },
        { label: 'Nascimento', kind: 'TextInput' },
        { label: 'Graus', kind: 'NativeSelect' },
      ]);
    });

    it('Requisitos: filtros da página', async () => {
      await openPage({ route: paths.requirements, signedInAs: 'examiner' }, 'Requisitos');
      await screen.findByRole('combobox', { name: 'Faixa' }, { timeout: 10000 });
      await expectNoZoom(main(), where('Requisitos, filtros'), [
        { label: 'Faixa', kind: 'NativeSelect' },
        { label: 'Tipo', kind: 'NativeSelect' },
      ]);
    });

    it('Requisitos: diálogo "Novo requisito", com seletores e áreas de texto', async () => {
      const { user } = await openPage(
        { route: paths.requirements, signedInAs: 'examiner' },
        'Requisitos',
      );
      await user.click(await screen.findByRole('button', { name: 'Novo requisito' }));
      const dialog = await screen.findByRole('dialog', { name: 'Novo requisito' });
      await expectNoZoom(dialog, where('Diálogo "Novo requisito"'), [
        { label: 'Faixa', kind: 'NativeSelect' },
        { label: 'Tipo', kind: 'NativeSelect' },
        { label: 'Categoria', kind: 'TextInput' },
        { label: 'Descrição', kind: 'Textarea' },
        { label: 'Resposta esperada', kind: 'Textarea' },
        { label: 'Ordem', kind: 'TextInput' },
      ]);
    });

    it('Eventos: diálogo "Novo evento"', async () => {
      const { user } = await openPage({ route: paths.events, signedInAs: 'examiner' }, 'Eventos');
      await user.click(await screen.findByRole('button', { name: 'Novo evento' }));
      const dialog = await screen.findByRole('dialog', { name: 'Novo evento' });
      await expectNoZoom(dialog, where('Diálogo "Novo evento"'), [
        { label: 'Nome', kind: 'TextInput' },
        { label: 'Data do exame', kind: 'TextInput' },
        { label: 'Situação', kind: 'NativeSelect' },
      ]);
    });

    it('Faixas: diálogo "Editar faixa"', async () => {
      const { user } = await openPage({ route: paths.belts, signedInAs: 'examiner' }, 'Faixas');
      await user.click(
        await screen.findByRole('button', { name: 'Editar faixa Amarela' }, { timeout: 10000 }),
      );
      const dialog = await screen.findByRole('dialog', { name: 'Editar faixa Amarela' });
      await expectNoZoom(dialog, where('Diálogo "Editar faixa"'), [
        { label: 'Idade mínima (anos)', kind: 'TextInput' },
      ]);
    });

    it('Dia do exame: evento e busca por nome', async () => {
      await openPage({ route: paths.examDay, signedInAs: 'examiner' }, 'Dia do exame');
      await screen.findByRole('searchbox', { name: 'Buscar por nome' }, { timeout: 10000 });
      await expectNoZoom(main(), where('Dia do exame'), [
        { label: 'Evento', kind: 'NativeSelect' },
        { label: 'Buscar por nome', kind: 'TextInput' },
      ]);
    });
  });

  describe('decisão do exame', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 10, 21, 9) });
      const db = createMockDb({ includeShowcase: true });
      db.settings.sensei_user_id = MOCK_USER_IDS.examiner;
      server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('diálogo "Reprovar exame": observação', async () => {
      const { user } = await openPage(
        { route: examPath(MOCK_EVENT_IDS.open, HELENA), signedInAs: 'examiner' },
        'Helena Prado',
      );
      // Under 1024 px the decision is in the bar: "Decidir" opens the panel with the buttons.
      const bar = await waitFor(() => {
        const area = document.querySelector<HTMLElement>('[data-decision-area="bar"]');
        if (area === null) throw new Error('A área de decisão da barra deveria estar na tela.');
        return area;
      });
      await user.click(await within(bar).findByRole('button', { name: 'Decidir' }));
      const panel = await screen.findByRole('dialog', { name: 'Decidir o exame' });
      await user.click(within(panel).getByRole('button', { name: 'Reprovar' }));
      const dialog = await screen.findByRole('dialog', { name: 'Reprovar exame' });
      await expectNoZoom(dialog, where('Diálogo "Reprovar exame"'), [
        { label: 'Observação (opcional)', kind: 'Textarea' },
      ]);
    });
  });
});

describe('#191 fora da simulação, o padrão dos outros testes continua desktop sem toque', () => {
  it('depois dos testes de toque, nenhuma consulta de toque ou de mouse vale', () => {
    for (const query of [
      '(hover: none)',
      '(pointer: coarse)',
      '(hover: hover)',
      '(pointer: fine)',
    ]) {
      expect(window.matchMedia(query).matches, query).toBe(false);
    }
    expect(window.matchMedia('(max-width: 48em)').matches).toBe(false);
    expect(navigator.maxTouchPoints).toBeUndefined();
  });
});

describe('#191 viewport sem atalho que tire o zoom com os dedos (§ 6.7)', () => {
  const page = new DOMParser().parseFromString(indexHtml, 'text/html');

  it('o index.html tem um único viewport, na largura do aparelho', () => {
    const metas = page.querySelectorAll('meta[name="viewport"]');
    expect(metas).toHaveLength(1);
    expect(metas[0]?.getAttribute('content')).toMatch(/width\s*=\s*device-width/i);
  });

  it('sem maximum-scale nem user-scalable=no/0 (o Android perderia o zoom de 200%)', () => {
    const content = page.querySelector('meta[name="viewport"]')?.getAttribute('content') ?? '';
    const settings = Object.fromEntries(
      content.split(/[,;]/).map((part) => {
        const [key = '', value = ''] = part.split('=');
        return [key.trim().toLowerCase(), value.trim().toLowerCase()];
      }),
    );
    expect(settings, `viewport: "${content}"`).not.toHaveProperty('maximum-scale');
    expect(['no', '0', 'false'], `viewport: "${content}"`).not.toContain(settings['user-scalable']);
  });
});
