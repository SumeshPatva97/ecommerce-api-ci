/**
 * Email provider adapter (OQ-08 vendor still open). Decision C2 (2026-11-19): local and test
 * capture uses the in-process FAKE adapter — messages are recorded in memory (and logged without
 * bodies or links) instead of being sent. No real email leaves development.
 */
export interface SendEmailInput {
  readonly to: string;
  readonly subject: string;
  readonly html?: string;
  readonly text?: string;
  readonly templateKey?: string;
  readonly variables?: Readonly<Record<string, unknown>>;
}

export interface SendEmailResult {
  readonly provider: string;
  readonly messageId: string;
  readonly accepted: boolean;
}

export interface EmailProviderAdapter {
  readonly name: string;
  send(input: SendEmailInput): Promise<SendEmailResult>;
}

export interface CapturedEmail extends SendEmailInput {
  readonly messageId: string;
  readonly capturedAt: Date;
}

/** Fake adapter with an inspectable outbox (bounded to the last 200 messages). */
export class FakeEmailProviderAdapter implements EmailProviderAdapter {
  readonly name = 'fake';
  readonly outbox: CapturedEmail[] = [];
  private counter = 0;

  async send(input: SendEmailInput): Promise<SendEmailResult> {
    await Promise.resolve();
    this.counter += 1;
    const messageId = `fake_email_${String(this.counter)}`;
    this.outbox.push({ ...input, messageId, capturedAt: new Date() });
    if (this.outbox.length > 200) this.outbox.shift();
    return { provider: this.name, messageId, accepted: true };
  }

  /** Latest captured message for an address (tests / local dev tooling). */
  latestFor(to: string): CapturedEmail | undefined {
    for (let i = this.outbox.length - 1; i >= 0; i -= 1) {
      const message = this.outbox[i];
      if (message?.to === to) return message;
    }
    return undefined;
  }
}

/** @deprecated B0-c scaffold name kept for compatibility; use FakeEmailProviderAdapter. */
export class MockEmailProviderAdapter extends FakeEmailProviderAdapter {}
