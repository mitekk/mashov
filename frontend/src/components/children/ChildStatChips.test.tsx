import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ChildStatChips } from './ChildStatChips';

const counts = {
  studentGuid: 'guid-1',
  homeworkCount: 3,
  attentionCount: 2,
  positiveCount: 1,
  neutralCount: 0,
};

const TESTIDS = [
  'child-list-homework-count-guid-1',
  'child-list-negative-count-guid-1',
  'child-list-positive-count-guid-1',
  'child-list-neutral-count-guid-1',
];

describe('ChildStatChips', () => {
  it('prints the label inside each pill in inline mode', () => {
    render(<ChildStatChips testIdPrefix="child-list" {...counts} />);

    expect(screen.getByTestId('child-list-homework-count-guid-1').textContent).toBe(
      '3 שיעורי בית',
    );
    expect(screen.getByTestId('child-list-negative-count-guid-1').textContent).toBe(
      '2 תשומת לב',
    );
    expect(screen.getByTestId('child-list-positive-count-guid-1').textContent).toBe(
      '1 חיוביים',
    );
    expect(screen.getByTestId('child-list-neutral-count-guid-1').textContent).toBe(
      '0 אחר',
    );
  });

  it('carries no title or aria-label in inline mode — the text is the name', () => {
    render(<ChildStatChips testIdPrefix="child-list" {...counts} />);

    for (const testId of TESTIDS) {
      const pill = screen.getByTestId(testId);
      expect(pill.getAttribute('title')).toBeNull();
      expect(pill.getAttribute('aria-label')).toBeNull();
    }
  });

  it('shows the number alone in tooltip mode', () => {
    render(<ChildStatChips testIdPrefix="child-list" labelMode="tooltip" {...counts} />);

    expect(screen.getByTestId('child-list-homework-count-guid-1').textContent).toBe('3');
    expect(screen.getByTestId('child-list-negative-count-guid-1').textContent).toBe('2');
    expect(screen.getByTestId('child-list-positive-count-guid-1').textContent).toBe('1');
    expect(screen.getByTestId('child-list-neutral-count-guid-1').textContent).toBe('0');
  });

  it('puts the label on hover and in the accessible name in tooltip mode', () => {
    render(<ChildStatChips testIdPrefix="child-list" labelMode="tooltip" {...counts} />);

    const homework = screen.getByTestId('child-list-homework-count-guid-1');
    expect(homework.getAttribute('title')).toBe('שיעורי בית');
    expect(homework.getAttribute('aria-label')).toBe('3 שיעורי בית');

    const attention = screen.getByTestId('child-list-negative-count-guid-1');
    expect(attention.getAttribute('title')).toBe('תשומת לב');
    expect(attention.getAttribute('aria-label')).toBe('2 תשומת לב');

    const positive = screen.getByTestId('child-list-positive-count-guid-1');
    expect(positive.getAttribute('title')).toBe('חיוביים');
    expect(positive.getAttribute('aria-label')).toBe('1 חיוביים');

    const neutral = screen.getByTestId('child-list-neutral-count-guid-1');
    expect(neutral.getAttribute('title')).toBe('אחר');
    expect(neutral.getAttribute('aria-label')).toBe('0 אחר');
  });

  it('emits identical testids in both modes', () => {
    const { unmount } = render(<ChildStatChips testIdPrefix="child-list" {...counts} />);
    for (const testId of TESTIDS) expect(screen.getByTestId(testId)).toBeTruthy();
    unmount();

    render(<ChildStatChips testIdPrefix="child-list" labelMode="tooltip" {...counts} />);
    for (const testId of TESTIDS) expect(screen.getByTestId(testId)).toBeTruthy();
  });

  it('prefixes the testids with the card family it sits in', () => {
    render(<ChildStatChips testIdPrefix="child-card" labelMode="tooltip" {...counts} />);

    expect(screen.getByTestId('child-card-homework-count-guid-1')).toBeTruthy();
    expect(screen.getByTestId('child-card-negative-count-guid-1')).toBeTruthy();
    expect(screen.getByTestId('child-card-positive-count-guid-1')).toBeTruthy();
    expect(screen.getByTestId('child-card-neutral-count-guid-1')).toBeTruthy();
  });

  it('keeps a zero quiet and a non-zero loud', () => {
    render(<ChildStatChips testIdPrefix="child-list" {...counts} />);

    expect(screen.getByTestId('child-list-homework-count-guid-1').className).toContain(
      'font-semibold',
    );
    expect(
      screen.getByTestId('child-list-neutral-count-guid-1').className,
    ).not.toContain('font-semibold');
  });
});
