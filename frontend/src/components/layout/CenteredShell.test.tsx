import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

const { CenteredShell } = await import('./CenteredShell');

describe('CenteredShell', () => {
  it('renders its children inside the panel', () => {
    render(
      <CenteredShell>
        <p>שלום</p>
      </CenteredShell>,
    );

    expect(screen.getByText('שלום')).not.toBeNull();
  });

  it('passes a testid through to the outer element, where the e2e suite looks for it', () => {
    render(
      <CenteredShell data-testid="telegram-setup-page">
        <p>שלום</p>
      </CenteredShell>,
    );

    const shell = screen.getByTestId('telegram-setup-page');
    expect(shell.className).toContain('min-h-dvh');
  });

  it('pads for the notch at every alignment', () => {
    // display: standalone means the status bar overlays the page, and these
    // four routes bypass AppShell -- so the padding has to come from here.
    const { container: centred } = render(<CenteredShell align="center">x</CenteredShell>);
    const { container: top } = render(<CenteredShell align="top">x</CenteredShell>);

    expect(centred.firstElementChild?.className).toContain('pt-safe');
    expect(top.firstElementChild?.className).toContain('pt-safe');
  });

  it('asks for centring by default', () => {
    // Class-string only: jsdom computes no layout, so the actual centring
    // is not observable here.
    const { container } = render(<CenteredShell>x</CenteredShell>);

    expect(container.firstElementChild?.className).toContain('place-items-center');
  });

  it('pins the panel to the top when asked, for pages with a back button', () => {
    const { container } = render(<CenteredShell align="top">x</CenteredShell>);

    expect(container.firstElementChild?.className).not.toContain('place-items-center');
  });

  it('carries both the phone cap and its md widening', () => {
    const { container } = render(<CenteredShell>x</CenteredShell>);
    const panel = container.querySelector('[data-shell-panel]');

    expect(panel?.className).toContain('max-w-sm');
    expect(panel?.className).toContain('md:max-w-md');
  });

  it('lets a route widen the panel itself', () => {
    const { container } = render(<CenteredShell panelClassName="lg:max-w-4xl">x</CenteredShell>);

    expect(container.querySelector('[data-shell-panel]')?.className).toContain('lg:max-w-4xl');
  });
});
