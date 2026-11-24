import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from './ConfirmDialog';

function renderDialog(overrides: Partial<React.ComponentProps<typeof ConfirmDialog>> = {}) {
  const onConfirm = vi.fn();
  const onOpenChange = vi.fn();
  const utils = render(
    <ConfirmDialog
      open
      onOpenChange={onOpenChange}
      testId="settings-unlink-modal"
      titleId="unlink-modal-title"
      title='לנתק את "אורט רעננה"?'
      description="יימחקו כל הנתונים של הילד בבית הספר הזה."
      cancelTestId="settings-unlink-cancel-btn"
      confirmTestId="settings-unlink-confirm-btn-1234"
      confirmLabel="ניתוק"
      pendingLabel="מנתק..."
      onConfirm={onConfirm}
      {...overrides}
    />,
  );
  return { ...utils, onConfirm, onOpenChange };
}

describe('ConfirmDialog', () => {
  it('renders nothing while closed', () => {
    renderDialog({ open: false });

    expect(screen.queryByTestId('settings-unlink-modal')).toBeNull();
  });

  it('keeps the testid the e2e page object addresses', () => {
    renderDialog();

    expect(screen.getByTestId('settings-unlink-modal')).not.toBeNull();
  });

  it('puts the title id on the heading, where school-links.spec.ts reads it', () => {
    renderDialog({ titleId: 'disconnect-modal-title', title: 'ניתוק מכל בתי הספר' });

    const heading = document.getElementById('disconnect-modal-title');
    expect(heading?.textContent).toBe('ניתוק מכל בתי הספר');
  });

  it('points aria-labelledby at that same heading', () => {
    // Radix's DialogTitle spreads caller props AFTER its own id, so passing
    // `id` RENAMES the heading while DialogContent keeps pointing
    // aria-labelledby at the context id that no longer exists. The dialog then
    // announces as an unlabelled alert dialog -- on three confirmations that
    // delete a household's data -- and Radix logs a console.error about it in
    // the production bundle. The label has to be passed explicitly.
    renderDialog({ titleId: 'disconnect-modal-title', title: 'ניתוק מכל בתי הספר' });

    const content = screen.getByRole('alertdialog');
    expect(content.getAttribute('aria-labelledby')).toBe('disconnect-modal-title');
    expect(document.getElementById('disconnect-modal-title')).not.toBeNull();
  });

  it('does not let Escape close the dialog mid-mutation', () => {
    // Confirm deliberately does not close, so a failure can be shown in place.
    // Escape would throw that away: the mutation keeps running, the dialog is
    // gone, and the error it was holding never reaches anyone.
    const { onOpenChange } = renderDialog({ isPending: true });

    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape', code: 'Escape' });

    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('still closes on Escape when idle', () => {
    const { onOpenChange } = renderDialog();

    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape', code: 'Escape' });

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('announces itself as an alert dialog', () => {
    renderDialog();

    expect(screen.getByRole('alertdialog')).not.toBeNull();
  });

  it('calls onConfirm without closing itself', () => {
    // The confirm must NOT close pre-emptively: the success path navigates and
    // unmounts, and closing first is what made a failure silent.
    const { onConfirm, onOpenChange } = renderDialog();

    fireEvent.click(screen.getByTestId('settings-unlink-confirm-btn-1234'));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('closes on cancel', () => {
    const { onOpenChange } = renderDialog();

    fireEvent.click(screen.getByTestId('settings-unlink-cancel-btn'));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('shows the pending label and disables both buttons while in flight', () => {
    renderDialog({ isPending: true });

    expect(screen.getByTestId('settings-unlink-confirm-btn-1234').textContent).toBe('מנתק...');
    expect(
      screen.getByTestId('settings-unlink-confirm-btn-1234').hasAttribute('disabled'),
    ).toBe(true);
    expect(screen.getByTestId('settings-unlink-cancel-btn').hasAttribute('disabled')).toBe(true);
  });

  it('renders an error as an alert, under its own testid', () => {
    renderDialog({ error: 'לא הצלחנו לנתק כרגע.', errorTestId: 'settings-unlink-error' });

    const alert = screen.getByTestId('settings-unlink-error');
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.textContent).toBe('לא הצלחנו לנתק כרגע.');
  });

  it('omits the error element when there is no error', () => {
    renderDialog({ errorTestId: 'settings-unlink-error' });

    expect(screen.queryByTestId('settings-unlink-error')).toBeNull();
  });

  it('keeps the dialog-panel class on the panel', () => {
    // That class is where `max-height: min(80svh, 46rem)` lives. jsdom
    // never evaluates it, so this pins the wiring, not the cap.
    renderDialog();

    expect(screen.getByTestId('settings-unlink-modal').className).toContain('dialog-panel');
  });

  it('marks both buttons with the tap-target class', () => {
    renderDialog();

    expect(screen.getByTestId('settings-unlink-cancel-btn').className).toContain('tap-target');
    expect(screen.getByTestId('settings-unlink-confirm-btn-1234').className).toContain(
      'tap-target',
    );
  });
});
