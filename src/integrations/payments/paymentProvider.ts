/**
 * B0-c scaffold: payment provider adapter contract (no production credentials, not production-verified).
 * Implementations must never trust client-provided amounts; all verification/idempotency/webhook signature
 * checks must follow approved API/security docs. Use env-based config and safe mock adapters for tests.
 */
export interface PaymentInitiationInput {
  readonly orderId: string;
  readonly amountMinor: number;
  readonly currency: 'INR';
  readonly idempotencyKey?: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface PaymentInitiationResult {
  readonly provider: string;
  readonly providerOrderId: string;
  readonly status: 'INITIATED' | 'PENDING' | 'FAILED';
  readonly raw?: unknown;
}

export interface PaymentVerificationInput {
  readonly provider: string;
  readonly payload: unknown;
  readonly signature?: string;
}

export interface PaymentVerificationResult {
  readonly verified: boolean;
  readonly providerPaymentId?: string;
  readonly status?: 'SUCCEEDED' | 'FAILED' | 'PENDING';
  readonly reason?: string;
}

export interface PaymentProviderAdapter {
  readonly name: string;
  initiate(input: PaymentInitiationInput): Promise<PaymentInitiationResult>;
  verify(input: PaymentVerificationInput): Promise<PaymentVerificationResult>;
}

export class MockPaymentProviderAdapter implements PaymentProviderAdapter {
  readonly name = 'mock';

  async initiate(input: PaymentInitiationInput): Promise<PaymentInitiationResult> {
    await Promise.resolve();
    return {
      provider: this.name,
      providerOrderId: `mock_${input.orderId}`,
      status: 'INITIATED',
      raw: { mock: true },
    };
  }

  async verify(_input: PaymentVerificationInput): Promise<PaymentVerificationResult> {
    await Promise.resolve();
    return {
      verified: false,
      status: 'PENDING',
      reason: 'Mock adapter: no real verification performed.',
    };
  }
}
