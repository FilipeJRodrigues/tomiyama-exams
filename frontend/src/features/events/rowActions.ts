/**
 * The row buttons of the events list carry the event id, so the page can give them the focus
 * back after a dialog or a change of layout (§ 6.7).
 */

/** Marks each row button: `edit:<id>` or `delete:<id>`. */
export const ACTION_ATTRIBUTE = 'data-event-action';

export type EventAction = 'edit' | 'delete';

export function actionKey(action: EventAction, id: string): string {
  return `${action}:${id}`;
}

/** The row button with this key (`actionKey`), if it is on the screen. */
export function actionButton(key: string): HTMLElement | null {
  const buttons = Array.from(document.querySelectorAll<HTMLElement>(`[${ACTION_ATTRIBUTE}]`));
  return buttons.find((button) => button.getAttribute(ACTION_ATTRIBUTE) === key) ?? null;
}
