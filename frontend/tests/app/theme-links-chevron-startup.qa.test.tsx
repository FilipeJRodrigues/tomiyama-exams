/**
 * Cobertura do #166, etapa 1a (§ 6.7; skill `tomiyama-design`), nos dois temas, na tela
 * montada (`tests/computedCss.ts`), além de `theme-anchor-underline.test.tsx` e
 * `theme-select-chevron.test.tsx`:
 * - links sublinhados pelo `Anchor.extend`, também os que perderam o `underline="always"`
 *   próprio (os links de `c="inherit"` dentro dos alertas vermelhos de entrar, recuperar senha
 *   e cadastro), os usados como botão ("Trocar e-mail"), os de alvo de toque (`TOUCH_LINK`,
 *   `inline-flex`), o nome do aluno na tabela e no título do cartão a 390 px e o link do aviso
 *   laranja de sensei; texto com 4,5:1 e anel de foco com 3:1 sobre o fundo de cada um; o menu
 *   em gaveta (`NavLink`) continua sem sublinhado;
 * - seta dos seletores na borda de controle no sensei somente leitura (desabilitado, com
 *   `READ_ONLY_SELECT_STYLES`) e no do master, na Academia, e dentro do diálogo "Novo
 *   requisito"; com erro ("Faixa atual" do novo aluno enviado vazio), na cor de erro com 3:1;
 * - tela "Erro ao iniciar" com o tema da escolha salva (escuro sem escolha ou com escolha
 *   inválida), as variáveis `--app-*` e o alerta legível.
 */
import { act, render, screen, within } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ConfigErrorScreen } from '../../src/app/ConfigErrorScreen';
import { examPath, paths } from '../../src/app/navigation';
import { COLOR_SCHEME_KEY } from '../../src/app/theme';
import { createMockAuth } from '../../src/auth/mockAuth';
import { MOCK_SIGN_UP_CODE } from '../../src/auth/mockConstants';
import { AuthError, type AuthService } from '../../src/auth/types';
import { MOCK_EVENT_IDS, createMockDb } from '../../src/mocks/data';
import { createHandlers } from '../../src/mocks/handlers';
import { Styles, expectContrast, hex, loadStyles } from '../computedCss';
import { installMockApi, server, TEST_API_URL } from '../msw-server';
import { renderApp, type RenderAppResult } from '../render';
import { setViewportWidth } from '../viewport';

type Scheme = 'light' | 'dark';

const MIN_TEXT = 4.5;
const MIN_INDICATOR = 3;
const CONTROL_BORDER: Record<Scheme, string> = { light: '#737b83', dark: '#8f8f8f' };
const EMAIL = 'mae@example.com';
const PASSWORD = 'senha-forte-1';
const HELENA = '7d0c6a52-1f0e-4f9b-9a51-0a1b2c3d4e08';

async function decoration(element: Element): Promise<string> {
  const styles = await Styles.now();
  const winner = styles.declared(element, ['text-decoration', 'text-decoration-line']);
  if (winner === null) return 'none';
  return styles.resolve(element, winner.value);
}

async function expectUnderlined(link: HTMLElement) {
  expect(await decoration(link), `"${link.textContent}" sublinhado`).toMatch(/\bunderline\b/);
}

/** Link text against what is behind it, and its focus ring against the same. */
async function expectReadableAndFocusable(link: HTMLElement, where: string) {
  let styles = await Styles.now();
  // `c="inherit"` (links inside alerts): the color is the one of the text around it.
  const own = styles.declared(link, ['color']);
  const colored = own?.value.trim() === 'inherit' ? (link.parentElement ?? link) : link;
  expectContrast(
    `texto de "${link.textContent}" sobre ${where}`,
    styles.textColor(colored),
    styles.background(link),
    MIN_TEXT,
  );
  act(() => {
    link.focus();
  });
  expect(link).toHaveFocus();
  styles = await Styles.now();
  expectContrast(
    `anel de foco de "${link.textContent}" sobre ${where}`,
    styles.focusRingColor(link),
    styles.background(link.parentElement ?? link),
    MIN_INDICATOR,
  );
}

async function reachConfirmStep({ user }: RenderAppResult) {
  await user.type(await screen.findByLabelText(/^E-mail/), EMAIL);
  await user.type(screen.getByLabelText(/^Senha/), PASSWORD);
  await user.type(screen.getByLabelText(/^Confirme a senha/), PASSWORD);
  await user.click(screen.getByRole('button', { name: 'Criar conta' }));
  await screen.findByRole('heading', { name: 'Confirme seu e-mail' });
}

/** Arrow of a select and the field it is drawn on. */
function chevronOf(select: HTMLElement) {
  const chevron = select
    .closest('.mantine-Input-wrapper')
    ?.querySelector('.mantine-ComboboxChevron-chevron');
  if (!chevron) throw new Error('O seletor deveria ter a seta.');
  return chevron;
}

async function expectChevron(select: HTMLElement, scheme: Scheme, where: string) {
  const styles = await Styles.now();
  const color = styles.textColor(chevronOf(select));
  expect(hex(color), `seta de ${where}`).toBe(CONTROL_BORDER[scheme]);
  expectContrast(`seta de ${where}`, color, styles.background(select), MIN_INDICATOR);
}

beforeAll(loadStyles);

describe.each<Scheme>(['light', 'dark'])('reteste #166 no tema %s', (scheme) => {
  beforeEach(() => {
    window.localStorage.setItem(COLOR_SCHEME_KEY, scheme);
  });

  describe('links dentro dos alertas, sem o underline repetido', () => {
    it('entrar: "Confirmar e-mail" no alerta vermelho', async () => {
      installMockApi();
      const auth = createMockAuth(null);
      await auth.signUp(EMAIL, PASSWORD);
      const app = await renderApp({ route: paths.login, auth });
      await app.user.type(await screen.findByLabelText(/^E-mail/), EMAIL);
      await app.user.type(screen.getByLabelText(/^Senha/), PASSWORD);
      await app.user.click(screen.getByRole('button', { name: 'Entrar' }));
      const alert = await screen.findByRole('alert');
      const link = within(alert).getByRole('link', { name: 'Confirmar e-mail' });
      expect(document.documentElement).toHaveAttribute('data-mantine-color-scheme', scheme);
      await expectUnderlined(link);
      await expectReadableAndFocusable(link, 'o alerta vermelho');
    });

    it('recuperar senha: "Confirmar e-mail" no alerta vermelho', async () => {
      installMockApi();
      const auth: AuthService = {
        ...createMockAuth(null),
        resetPassword: () =>
          Promise.reject(
            new AuthError('Este e-mail ainda não foi confirmado.', 'USER_NOT_CONFIRMED'),
          ),
      };
      const app = await renderApp({ route: paths.forgotPassword, auth });
      await app.user.type(await screen.findByLabelText(/^E-mail/), EMAIL);
      await app.user.click(screen.getByRole('button', { name: 'Enviar código' }));
      const alert = await screen.findByRole('alert');
      const link = within(alert).getByRole('link', { name: 'Confirmar e-mail' });
      await expectUnderlined(link);
      await expectReadableAndFocusable(link, 'o alerta vermelho');
    });

    it('cadastro: "Entrar" no alerta de conta já confirmada; "Trocar e-mail" sublinhado', async () => {
      installMockApi();
      const app = await renderApp({
        route: paths.signUp,
        auth: {
          ...createMockAuth(null),
          confirmSignUp: () =>
            Promise.reject(new AuthError('Este e-mail já foi confirmado.', 'ALREADY_CONFIRMED')),
        },
      });
      await reachConfirmStep(app);
      const change = screen.getByRole('button', { name: 'Trocar e-mail' });
      await expectUnderlined(change);
      await expectReadableAndFocusable(change, 'o cartão');
      await app.user.type(screen.getByLabelText(/^Código/), MOCK_SIGN_UP_CODE);
      await app.user.click(screen.getByRole('button', { name: 'Confirmar' }));
      const alert = await screen.findByRole('alert');
      const link = within(alert).getByRole('link', { name: 'Entrar' });
      await expectUnderlined(link);
      await expectReadableAndFocusable(link, 'o alerta vermelho');
    });

    it('recuperar senha, nova senha: "Trocar e-mail" e "Voltar para o login" (alvo de toque)', async () => {
      installMockApi();
      const app = await renderApp({ route: paths.forgotPassword });
      await app.user.type(await screen.findByLabelText(/^E-mail/), EMAIL);
      await app.user.click(screen.getByRole('button', { name: 'Enviar código' }));
      await screen.findByRole('heading', { name: 'Crie uma nova senha' });
      for (const control of [
        screen.getByRole('button', { name: 'Trocar e-mail' }),
        screen.getByRole('link', { name: 'Voltar para o login' }),
      ]) {
        // TOUCH_LINK makes them inline-flex 44 px targets; the underline still wins.
        expect(control).toHaveStyle({ display: 'inline-flex' });
        await expectUnderlined(control);
        await expectReadableAndFocusable(control, 'o cartão');
      }
    });

    it('exame: "Abrir configurações da academia" no aviso laranja de sensei', async () => {
      const db = createMockDb({ includeShowcase: true });
      db.settings.sensei_user_id = null;
      server.use(...createHandlers({ baseUrl: TEST_API_URL, db }));
      await renderApp({ route: examPath(MOCK_EVENT_IDS.open, HELENA), signedInAs: 'examiner' });
      await screen.findByRole('heading', { level: 1, name: 'Helena Prado' });
      const summary = screen.getByRole('complementary', { name: 'Resumo do exame' });
      const note = await within(summary).findByRole('note');
      const link = within(note).getByRole('link', { name: 'Abrir configurações da academia' });
      await expectUnderlined(link);
      await expectReadableAndFocusable(link, 'o aviso laranja');
    });
  });

  describe('nome do aluno', () => {
    it('tabela (1280 px): nome sublinhado e legível na linha', async () => {
      installMockApi();
      await renderApp({ route: paths.students, signedInAs: 'examiner' });
      await screen.findByRole('heading', { name: 'Alunos', level: 1 });
      const table = await screen.findByRole('table', {}, { timeout: 10000 });
      const links = within(table).getAllByRole('link');
      expect(links.length).toBeGreaterThan(0);
      for (const link of links.slice(0, 3)) {
        await expectUnderlined(link);
        await expectReadableAndFocusable(link, 'a linha da tabela');
      }
    });

    it('cartões (390 px): nome no título sublinhado; menu em gaveta sem sublinhado', async () => {
      installMockApi();
      setViewportWidth(390);
      const app = await renderApp({ route: paths.students, signedInAs: 'examiner' });
      await screen.findByRole('heading', { name: 'Alunos', level: 1 });
      const [item] = await screen.findAllByRole('listitem', {}, { timeout: 10000 });
      const title = within(item!).getByRole('heading', { level: 2 });
      const link = within(title).getByRole('link');
      await expectUnderlined(link);
      await expectReadableAndFocusable(link, 'o cartão');

      await app.user.click(screen.getByRole('button', { name: 'Abrir menu' }));
      const menu = screen.getByRole('navigation', { name: 'Menu principal' });
      for (const navItem of within(menu).getAllByRole('link')) {
        expect(navItem).not.toHaveAttribute('data-underline');
        expect(await decoration(navItem)).not.toMatch(/\bunderline\b/);
      }
    });
  });

  describe('seta dos seletores', () => {
    it('academia, examinador comum: sensei desabilitado com seta e valor legíveis', async () => {
      installMockApi();
      await renderApp({ route: paths.academy, signedInAs: 'examiner' });
      await screen.findByRole('form', { name: 'Dados da academia' });
      const select = screen.getByRole('combobox', { name: /^Sensei/ });
      expect(select).toBeDisabled();
      await expectChevron(select, scheme, 'sensei somente leitura');
      const styles = await Styles.now();
      expectContrast(
        'valor do sensei somente leitura',
        styles.textColor(select),
        styles.background(select),
        MIN_TEXT,
      );
    });

    it('academia, master: sensei habilitado', async () => {
      installMockApi();
      await renderApp({ route: paths.academy, signedInAs: 'master' });
      await screen.findByRole('form', { name: 'Dados da academia' });
      const select = screen.getByRole('combobox', { name: /^Sensei/ });
      expect(select).toBeEnabled();
      await expectChevron(select, scheme, 'sensei do master');
    });

    it('novo aluno enviado vazio: "Faixa atual" com erro na cor de erro; "Graus" na borda', async () => {
      installMockApi();
      const app = await renderApp({ route: paths.studentNew, signedInAs: 'examiner' });
      const belt = await screen.findByRole(
        'combobox',
        { name: /^Faixa atual/ },
        { timeout: 10000 },
      );
      await app.user.click(screen.getByRole('button', { name: 'Cadastrar aluno' }));
      expect(belt).toHaveAttribute('aria-invalid', 'true');
      const styles = await Styles.now();
      const errorColor = styles.textColor(chevronOf(belt));
      expect(hex(errorColor)).toBe(scheme === 'light' ? '#d62211' : '#ff8577');
      expectContrast('seta com erro', errorColor, styles.background(belt), MIN_INDICATOR);
      await expectChevron(screen.getByRole('combobox', { name: /^Graus/ }), scheme, '"Graus"');
    });

    it('requisitos: "Faixa" e "Tipo" dentro do diálogo "Novo requisito"', async () => {
      installMockApi();
      const app = await renderApp({ route: paths.requirements, signedInAs: 'examiner' });
      await screen.findByRole('heading', { name: 'Requisitos', level: 1 });
      await app.user.click(
        await screen.findByRole('button', { name: 'Novo requisito' }, { timeout: 10000 }),
      );
      const dialog = await screen.findByRole('dialog');
      for (const name of ['Faixa', 'Tipo']) {
        const select = within(dialog).getByRole('combobox', { name: new RegExp(`^${name}`) });
        await expectChevron(select, scheme, `"${name}" no diálogo`);
      }
    });
  });
});

describe('tela de erro ao iniciar', () => {
  const MESSAGE = 'Configuração ausente: VITE_API_URL.';

  it.each<[string, string | null, Scheme]>([
    ['sem escolha salva', null, 'dark'],
    ['escolha salva "light"', 'light', 'light'],
    ['escolha salva "dark"', 'dark', 'dark'],
    ['escolha inválida', 'roxo', 'dark'],
  ])('%s: tema %s, variáveis --app-* e alerta legível', async (_case, saved, expected) => {
    if (saved !== null) window.localStorage.setItem(COLOR_SCHEME_KEY, saved);
    render(<ConfigErrorScreen message={MESSAGE} />);
    const alert = await screen.findByRole('alert');
    expect(document.documentElement).toHaveAttribute('data-mantine-color-scheme', expected);
    const styles = await Styles.now();
    for (const name of ['--app-surface', '--app-focus-ring', '--app-control-border']) {
      expect(styles.resolve(alert, `var(${name})`), name).toMatch(/^(#|var|rgb)/);
    }
    expect(styles.resolve(alert, 'var(--app-control-border)').toLowerCase()).toBe(
      CONTROL_BORDER[expected],
    );
    expectContrast(
      'mensagem do erro ao iniciar',
      styles.textColor(within(alert).getByText(MESSAGE)),
      styles.background(alert),
      MIN_TEXT,
    );
    expectContrast(
      'título do erro ao iniciar',
      styles.textColor(within(alert).getByText('Erro ao iniciar')),
      styles.background(alert),
      MIN_TEXT,
    );
  });
});
