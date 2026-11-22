import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ChildListItem, DigestRecipient } from '@/types/api';
import { TelegramCard } from './TelegramCard';

function child(
  overrides: Partial<ChildListItem> & Pick<ChildListItem, 'studentGuid'>,
): ChildListItem {
  return {
    privateName: 'מיקה',
    familyName: 'קורס',
    fullName: 'מיקה קורס',
    classCode: 'ז',
    classNum: 3,
    gender: 'נ',
    isActive: true,
    recentHomeworkCount: 0,
    recentBehaviorCount: 0,
    positiveBehaviorCount: 0,
    neutralBehaviorCount: 0,
    subjectCount: 0,
    latestUpdateAt: null,
    schoolId: 'conn-1',
    schoolName: 'תיכון הרצוג',
    schoolShortLabel: 'הרצוג',
    semel: 111,
    ...overrides,
  };
}

function recipient(
  overrides: Partial<DigestRecipient> & Pick<DigestRecipient, 'id' | 'studentGuid'>,
): DigestRecipient {
  return {
    userId: 'user-1',
    channel: 'telegram',
    address: '98765',
    displayName: null,
    enabled: true,
    activeFrom: '2026-11-21T10:00:00Z',
    createdAt: '2026-11-21T10:00:00Z',
    updatedAt: '2026-11-21T10:00:00Z',
    ...overrides,
  };
}

function renderCard(props: Partial<React.ComponentProps<typeof TelegramCard>> = {}) {
  const onToggle = vi.fn();
  const onDisconnect = vi.fn();
  render(
    <TelegramCard
      recipients={[]}
      allChildren={[child({ studentGuid: 'stu-1' })]}
      onToggle={onToggle}
      onDisconnect={onDisconnect}
      {...props}
    />,
  );
  return { onToggle, onDisconnect };
}

describe('TelegramCard — not connected', () => {
  it('offers the wizard as a single row', () => {
    renderCard();

    const cta = screen.getByTestId('telegram-card-connect-link');
    expect(cta.getAttribute('href')).toBe('/more/telegram');
  });

  it('shows no per-child toggle and no disconnect', () => {
    renderCard();

    expect(screen.queryByTestId('telegram-card-toggle-stu-1')).toBeNull();
    expect(screen.queryByTestId('telegram-card-disconnect-btn')).toBeNull();
  });

  it('ignores a recipient on another channel', () => {
    // A 'log' row is a dev affordance, not a Telegram subscription.
    renderCard({
      recipients: [recipient({ id: 'rec-1', studentGuid: 'stu-1', channel: 'log' })],
    });

    expect(screen.getByTestId('telegram-card-connect-link')).toBeTruthy();
  });
});

describe('TelegramCard — connected', () => {
  const CONNECTED = {
    recipients: [recipient({ id: 'rec-1', studentGuid: 'stu-1' })],
    allChildren: [child({ studentGuid: 'stu-1' })],
  };

  it('shows a row per subscribed child, named and with its class', () => {
    renderCard(CONNECTED);

    const row = screen.getByTestId('telegram-card-row-stu-1');
    expect(row.textContent).toContain('מיקה קורס');
    expect(row.textContent).toContain('ז3');
  });

  it('reflects the enabled flag in the toggle', () => {
    renderCard({
      ...CONNECTED,
      recipients: [recipient({ id: 'rec-1', studentGuid: 'stu-1', enabled: false })],
    });

    expect((screen.getByTestId('telegram-card-toggle-stu-1') as HTMLInputElement).checked).toBe(
      false,
    );
  });

  it('asks to turn a child off by recipient id', () => {
    const { onToggle } = renderCard(CONNECTED);

    fireEvent.click(screen.getByTestId('telegram-card-toggle-stu-1'));

    expect(onToggle).toHaveBeenCalledWith('rec-1', false);
  });

  it('asks to turn a child back on', () => {
    const { onToggle } = renderCard({
      ...CONNECTED,
      recipients: [recipient({ id: 'rec-1', studentGuid: 'stu-1', enabled: false })],
    });

    fireEvent.click(screen.getByTestId('telegram-card-toggle-stu-1'));

    expect(onToggle).toHaveBeenCalledWith('rec-1', true);
  });

  it('hides the school label when there is only one school', () => {
    renderCard(CONNECTED);

    expect(screen.queryByTestId('telegram-card-school-stu-1')).toBeNull();
  });

  it('labels each child with its school when the parent has more than one', () => {
    renderCard({
      recipients: [
        recipient({ id: 'rec-1', studentGuid: 'stu-1' }),
        recipient({ id: 'rec-2', studentGuid: 'stu-2' }),
      ],
      allChildren: [
        child({ studentGuid: 'stu-1' }),
        child({ studentGuid: 'stu-2', schoolId: 'conn-2', schoolShortLabel: 'אורט' }),
      ],
    });

    expect(screen.getByTestId('telegram-card-school-stu-1').textContent).toContain('הרצוג');
    expect(screen.getByTestId('telegram-card-school-stu-2').textContent).toContain('אורט');
  });

  it('offers to add a child who has no subscription yet', () => {
    renderCard({
      recipients: [recipient({ id: 'rec-1', studentGuid: 'stu-1' })],
      allChildren: [child({ studentGuid: 'stu-1' }), child({ studentGuid: 'stu-2' })],
    });

    const add = screen.getByTestId('telegram-card-add-child-link');
    expect(add.getAttribute('href')).toBe('/more/telegram');
  });

  it('does not offer to add a child when every child is already subscribed', () => {
    renderCard(CONNECTED);

    expect(screen.queryByTestId('telegram-card-add-child-link')).toBeNull();
  });

  it('offers to disconnect', () => {
    const { onDisconnect } = renderCard(CONNECTED);

    fireEvent.click(screen.getByTestId('telegram-card-disconnect-btn'));

    expect(onDisconnect).toHaveBeenCalledTimes(1);
  });

  it('still lets a departed child be turned off', () => {
    // The roster can lose a child while their subscription row survives. A row
    // with no name is still a row the parent must be able to switch off.
    renderCard({
      recipients: [recipient({ id: 'rec-1', studentGuid: 'gone' })],
      allChildren: [child({ studentGuid: 'stu-1' })],
    });

    expect(screen.getByTestId('telegram-card-toggle-gone')).toBeTruthy();
  });

  it('names a departed child the same way to a screen reader as on screen', () => {
    // The visible row already says "ילד שאינו מופיע ברשימה". The switch's
    // aria-label read out the raw studentGuid instead -- a 36-character
    // identifier spelled out character by character, naming nothing a parent
    // has ever seen.
    renderCard({
      recipients: [recipient({ id: 'rec-1', studentGuid: 'gone' })],
      allChildren: [child({ studentGuid: 'stu-1' })],
    });

    const label = screen.getByTestId('telegram-card-toggle-gone').getAttribute('aria-label');
    expect(label).toBe('עדכונים בטלגרם על ילד שאינו מופיע ברשימה');
  });

  it('disables the toggle that is mid-flight', () => {
    renderCard({ ...CONNECTED, pendingToggleId: 'rec-1' });

    expect((screen.getByTestId('telegram-card-toggle-stu-1') as HTMLInputElement).disabled).toBe(
      true,
    );
  });

  it('shows what went wrong with the last toggle', () => {
    renderCard({ ...CONNECTED, toggleError: 'לא הצלחנו לעדכן' });

    expect(screen.getByTestId('telegram-card-toggle-error').textContent).toContain(
      'לא הצלחנו לעדכן',
    );
  });
});
