import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CaptchaEscapeHatch } from './CaptchaEscapeHatch';

/**
 * This component only exists because Mashov's Turnstile site key is
 * domain-locked. Mounting the widget with key `0x4AAAAAACI5UnCCPR536XNv` on
 * `http://127.0.0.1:8777` returns Cloudflare error **110200** ("domain not
 * allowed"), so no token we could produce would satisfy their key.
 *
 * It is the one place in the app that points at web.mashov.info, and the tests
 * below are mostly there to keep it that way.
 */
describe('CaptchaEscapeHatch', () => {
  it('links to the Mashov login so a locked-out parent has a path at all', async () => {
    render(<CaptchaEscapeHatch testIdPrefix="sign-in" />);

    const link = screen.getByTestId('sign-in-captcha-escape-link');
    expect(link).toHaveAttribute('href', 'https://web.mashov.info/students/login');
  });

  it('opens in a new tab without leaking our page as a referrer', async () => {
    render(<CaptchaEscapeHatch testIdPrefix="sign-in" />);

    const link = screen.getByTestId('sign-in-captcha-escape-link');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
    expect(link).toHaveAttribute('rel', expect.stringContaining('noreferrer'));
  });

  it('explains why, in Hebrew, rather than just dumping a link', async () => {
    render(<CaptchaEscapeHatch testIdPrefix="sign-in" />);

    const panel = screen.getByTestId('sign-in-captcha-escape');
    expect(panel.textContent).toMatch(/[֐-׿]/);
    // The important half: come back here afterwards.
    expect(panel.textContent).toContain('לחזור לכאן');
  });

  it('namespaces its testids, so several screens can mount it', async () => {
    render(<CaptchaEscapeHatch testIdPrefix="forgot-password" />);

    expect(screen.getByTestId('forgot-password-captcha-escape')).toBeInTheDocument();
    expect(screen.queryByTestId('sign-in-captcha-escape')).toBeNull();
  });
});
