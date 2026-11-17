/**
 * B0-c scaffold: email provider adapter. No production credentials/verification.
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

export class MockEmailProviderAdapter implements EmailProviderAdapter {
  readonly name = 'mock';

  async send(_input: SendEmailInput): Promise<SendEmailResult> {
    await Promise.resolve();
    return { provider: this.name, messageId: `mock_email_${Date.now()}`, accepted: true };
  }
}
