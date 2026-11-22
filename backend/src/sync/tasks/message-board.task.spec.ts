import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * One guard, on the one thing about this task that is easy to break silently.
 *
 * `MessageBoardItem.firstSeenAt` is what the digest reads to decide a notice
 * is new, and it only means that while the 06:00 upsert writes it on create
 * and never on update. Setting it in the `update` branch -- which is the
 * natural thing to do when adding a field to an upsert -- would make every
 * notice on the board new again every morning, and the parent would get the
 * whole board daily. The @default(now()) fills it on create, so the task
 * should not name the column at all.
 */
describe('MessageBoardTask', () => {
  it('never writes firstSeenAt, so a notice is new exactly once', () => {
    const source = readFileSync(join(__dirname, 'message-board.task.ts'), 'utf8');

    expect(source).not.toContain('firstSeenAt');
  });
});
