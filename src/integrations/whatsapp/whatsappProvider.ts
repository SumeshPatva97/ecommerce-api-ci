/**
 * B0-c scaffold: WhatsApp Business adapter. No production credentials/verification.
 */
export interface SendWhatsAppInput {
  readonly to: string;
  readonly templateKey?: string;
  readonly text?: string;
  readonly variables?: Readonly<Record<string, unknown>>;
}

export interface SendWhatsAppResult {
  readonly provider: string;
  readonly messageId: string;
  readonly accepted: boolean;
}

export interface WhatsAppProviderAdapter {
  readonly name: string;
  send(input: SendWhatsAppInput): Promise<SendWhatsAppResult>;
}

export class MockWhatsAppProviderAdapter implements WhatsAppProviderAdapter {
  readonly name = 'mock';

  async send(_input: SendWhatsAppInput): Promise<SendWhatsAppResult> {
    await Promise.resolve();
    return { provider: this.name, messageId: `mock_wa_${Date.now()}`, accepted: true };
  }
}
