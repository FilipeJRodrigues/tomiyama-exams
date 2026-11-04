/**
 * Erro: na Academia, quando a leitura de um logo falha, o slot mostra "Não foi possível
 * carregar o logo …" com "Tentar de novo" (o `LoadError` do slot, com `retryRef`). O slot só
 * devolve o foco depois desse botão quando a marca "o logo pode ter mudado" está ligada (um
 * envio gravado sem releitura). Na falha da primeira leitura da tela, ao acionar "Tentar de
 * novo" pelo teclado o botão fica desabilitado (o navegador põe o foco no `body`) e some quando
 * o logo chega: o foco fica no `body`. Se a leitura falha de novo (com ou sem a marca), o botão
 * volta e o foco continua no `body`.
 * Esperado (§ 6.7, regra única `focusIfLost`, como o próprio slot já faz depois de um envio):
 * se a leitura traz o logo, o foco fica no slot ("Carregar"/"Trocar logo …"); se falha de novo,
 * vai para o "Tentar de novo" que volta. Um foco posto em outro lugar fica onde está.
 * Issue: #52 (achado no QA do #26, etapa 2)
 *
 * jsdom não aplica a regra de "focus fixup" do HTML: no navegador, o botão com foco que fica
 * desabilitado (o `loading` do Mantine) perde o foco para o `body`. `emulateFocusFixup` faz o
 * mesmo aqui. As leituras são respondidas pelo teste (`answer`), sem espera de tempo real.
 * O teste "guarda" passa no código atual e precisa continuar passando depois da correção.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createMockDb } from '../../src/mocks/data';
import { createHandlers } from '../../src/mocks/handlers';
import { openAcademy } from '../features/academy/helpers';
import {
  PNG_BYTES,
  fileInput,
  imageFile,
  logoUrl,
  slotRegion,
} from '../features/academy/logoHelpers';
import { server, TEST_API_URL } from '../msw-server';
import { renderApp } from '../render';

const BUSY = 'Sistema ocupado no momento. Tente de novo em instantes.';
const LOAD_ERROR = 'Não foi possível carregar o logo principal';
const RETRY = 'Tentar de novo';

type Outcome = 'ok' | 'error';

/**
 * The GETs of the primary logo: the first `failFirst` fail (503); each one after waits until
 * `answer` says whether it brings the logo (the simulated API answers) or fails again.
 */
function primaryReads({ failFirst }: { failFirst: boolean }) {
  const waiting: ((outcome: Outcome) => void)[] = [];
  let held = false;
  let reads = 0;
  server.use(
    http.get(logoUrl('primary'), async () => {
      reads += 1;
      if (reads === 1 && failFirst) return HttpResponse.json({ message: BUSY }, { status: 503 });
      if (!held) return undefined;
      const outcome = await new Promise<Outcome>((resolve) => {
        waiting.push(resolve);
      });
      return outcome === 'ok' ? undefined : HttpResponse.json({ message: BUSY }, { status: 503 });
    }),
  );
  return {
    /** From now on each read waits for `answer`. */
    hold: () => {
      held = true;
    },
    answer: async (outcome: Outcome) => {
      await waitFor(() => {
        expect(waiting.length).toBeGreaterThan(0);
      });
      waiting.shift()!(outcome);
    },
  };
}

/**
 * The HTML focus fixup rule, which jsdom lacks: the focused button that becomes disabled loses
 * the focus to the body. jsdom ignores `blur()` on a disabled button, so a throwaway element
 * takes the focus and is removed.
 */
function emulateFocusFixup(): () => void {
  const observer = new MutationObserver(() => {
    const active = document.activeElement;
    if (!(active instanceof HTMLButtonElement) || !active.disabled) return;
    const temp = document.createElement('div');
    temp.tabIndex = -1;
    document.body.append(temp);
    temp.focus();
    temp.remove();
  });
  observer.observe(document.body, {
    subtree: true,
    attributes: true,
    attributeFilter: ['disabled'],
  });
  return () => {
    observer.disconnect();
  };
}

/** Where the focus is, in a short form for the failure message (`body` when lost). */
function focusedElement(): string {
  const active = document.activeElement;
  if (active === null || active === document.body) return 'body';
  const name = active.getAttribute('aria-label') ?? active.textContent.trim();
  return `${active.tagName.toLowerCase()} "${name}"`;
}

/** Runs what is queued (a `setTimeout(0)` that moves the focus), with no real wait. */
async function flushQueued() {
  for (let round = 0; round < 3; round += 1) {
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    });
  }
}

function retryButton(): HTMLButtonElement {
  return within(slotRegion('primary')).getByRole<HTMLButtonElement>('button', { name: RETRY });
}

async function openWithLoadError() {
  const reads = primaryReads({ failFirst: true });
  const rendered = await renderApp({ route: '/academia', signedInAs: 'examiner' });
  const alert = await within(await screen.findByRole('region', { name: 'Logo principal' }))
    .findByText(LOAD_ERROR)
    .then((title) => title.closest<HTMLElement>('[role="alert"]')!);
  expect(alert).toHaveTextContent(BUSY);
  reads.hold();
  return { ...rendered, reads };
}

async function retryWithKeyboard(user: Awaited<ReturnType<typeof renderApp>>['user']) {
  retryButton().focus();
  await user.keyboard('{Enter}');
}

async function expectFocusOnRetry() {
  await waitFor(() => {
    expect(retryButton()).toBeEnabled();
  });
  await waitFor(
    () => {
      expect(focusedElement()).toBe(`button "${RETRY}"`);
      expect(retryButton()).toHaveFocus();
    },
    { timeout: 1500 },
  );
}

describe('rn012 foco depois de "Tentar de novo" da leitura do logo (§ 6.6, § 6.7)', () => {
  let stopFixup: () => void = () => undefined;

  beforeEach(() => {
    server.use(...createHandlers({ baseUrl: TEST_API_URL, db: createMockDb() }));
    stopFixup = emulateFocusFixup();
  });

  afterEach(() => {
    stopFixup();
  });

  it('a primeira leitura falhou e a nova traz o logo: o foco fica no slot', async () => {
    const { user, reads } = await openWithLoadError();

    await retryWithKeyboard(user);
    await reads.answer('ok');
    expect(await within(slotRegion('primary')).findByText('Nenhum logo')).toBeVisible();

    await waitFor(
      () => {
        const active = document.activeElement;
        expect(
          active !== document.body && slotRegion('primary').contains(active),
          `foco em ${focusedElement()}, esperado no slot do logo principal`,
        ).toBe(true);
      },
      { timeout: 1500 },
    );
  });

  it('a primeira leitura falhou e a nova falha de novo: o foco vai para "Tentar de novo"', async () => {
    const { user, reads } = await openWithLoadError();

    await retryWithKeyboard(user);
    await reads.answer('error');

    await expectFocusOnRetry();
  });

  it('logo gravado sem releitura, e a nova leitura falha de novo: o foco vai para "Tentar de novo"', async () => {
    const reads = primaryReads({ failFirst: false });
    const { user } = await openAcademy();
    await within(slotRegion('primary')).findByText('Nenhum logo');
    // The read after the PUT fails: the slot's mark is on and it shows the read error.
    reads.hold();
    await user.upload(fileInput('primary'), imageFile(PNG_BYTES, 'logo.png', 'image/png'));
    await reads.answer('error');
    await within(slotRegion('primary')).findByText(LOAD_ERROR);
    // The slot already moves the focus to its "Tentar de novo" here (after the write).
    await waitFor(() => {
      expect(focusedElement(), 'depois do envio').toBe(`button "${RETRY}"`);
    });

    await retryWithKeyboard(user);
    await reads.answer('error');

    await expectFocusOnRetry();
  });

  it('guarda: o foco posto em outro lugar durante a leitura não é roubado', async () => {
    const { user, reads } = await openWithLoadError();
    const signOut = screen.getByRole('button', { name: 'Sair' });

    await retryWithKeyboard(user);
    signOut.focus();
    await reads.answer('error');
    await waitFor(() => {
      expect(retryButton()).toBeEnabled();
    });
    await flushQueued();
    expect(focusedElement()).toBe('button "Sair"');

    fireEvent.click(retryButton());
    await reads.answer('ok');
    expect(await within(slotRegion('primary')).findByText('Nenhum logo')).toBeVisible();
    await flushQueued();
    expect(focusedElement()).toBe('button "Sair"');
  });
});
