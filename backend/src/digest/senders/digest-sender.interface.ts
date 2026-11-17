/**
 * A delivery channel for a rendered digest.
 *
 * Telegram is the only real implementation today; the interface exists so the
 * channel is a configuration detail rather than a rewrite, and so dev, tests,
 * and dry runs can use a sink that sends nothing. See ADR-0026.
 */
export interface DigestSender {
  /** Matches `DigestRecipient.channel`. */
  readonly channel: string;

  /**
   * Delivers the message, or throws. The orchestrator treats a throw as a
   * failed send: the claim is rolled back and the next hourly run retries.
   * Implementations must never put a credential in the thrown error.
   */
  send(address: string, text: string): Promise<void>;
}
