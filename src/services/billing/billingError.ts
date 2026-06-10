import type { BillingErrorCode } from '../../types/billing';

export class BillingError extends Error {
  status: number;
  code: BillingErrorCode;

  constructor(status: number, code: BillingErrorCode, message: string) {
    super(message);
    this.name = 'BillingError';
    this.status = status;
    this.code = code;
  }
}

/** Strip sensitive details from Stripe/API errors before logging or returning. */
export function sanitizeExternalError(err: unknown): string {
  if (err instanceof BillingError) return err.message;
  if (err instanceof Error) {
    const msg = err.message;
    if (/sk_(live|test)_/i.test(msg)) return 'Payment provider error';
    if (/whsec_/i.test(msg)) return 'Payment provider error';
    return msg.length > 200 ? `${msg.slice(0, 200)}…` : msg;
  }
  return 'An unexpected error occurred';
}
