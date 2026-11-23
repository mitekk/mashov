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

  it('labels itself with the title, by the id callers rely on', () => {
    // school-links.spec.ts asserts on `#disconnect-modal-title` directly, so
    // the id has to land on the heading and not merely in aria-labelledby.
    renderDialog({ titleId: 'disconnect-modal-title', title: 'ניתוק מכל בתי הספר' });

    const heading = document.getElementById('disconnect-modal-title');
    expect(heading?.textContent).toBe('ניתוק מכל בתי הספר');
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

  it('caps its height so a long description cannot clip on iOS', () => {
    renderDialog();

    expect(screen.getByTestId('settings-unlink-modal').className).toContain('dialog-panel');
  });

  it('keeps both buttons tap targets', () => {
    renderDialog();

    expect(screen.getByTestId('settings-unlink-cancel-btn').className).toContain('tap-target');
    expect(screen.getByTestId('settings-unlink-confirm-btn-1234').className).toContain(
      'tap-target',
    );
  });
});
