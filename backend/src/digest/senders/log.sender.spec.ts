import { LogSender } from './log.sender';

describe('LogSender', () => {
  it('identifies itself as the log channel', () => {
    expect(new LogSender().channel).toBe('log');
  });

  it('records what it would have sent instead of sending it', async () => {
    const sender = new LogSender();
    const logged: string[] = [];
    jest
      .spyOn((sender as unknown as { logger: { log: (m: string) => void } }).logger, 'log')
      .mockImplementation((message: string) => logged.push(String(message)));

    await sender.send('chat-1', 'שלום');

    expect(logged.join('\n')).toContain('chat-1');
    expect(logged.join('\n')).toContain('שלום');
  });
});
