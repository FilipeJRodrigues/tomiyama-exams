import { screen } from '@testing-library/react';
import { expect } from 'vitest';

/** Words of the Cognito and Amplify messages (in English); none of them may reach the screen. */
const ENGLISH =
  /\b(code|password|reset|user|error|exception|limit|exceeded|attempts?|the|your|please|try|again|not|found|invalid|expired|mismatch|cannot|network)\b/i;

/** Checks the text of the screen (`main`; the body also holds Mantine's `<style>`). */
export function expectNoEnglish(): void {
  expect(screen.getByRole('main').textContent).not.toMatch(ENGLISH);
}
