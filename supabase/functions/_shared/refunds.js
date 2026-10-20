// Razorpay refund helpers shared by oms-api and razorpay-webhook. No Deno APIs, so Node tests can import them.

// A Razorpay payment's state, in the terms of payments.status. Partial refunds are reported as 'refunded' with
// amount_refunded below the amount; oms_apply_payment keeps those orders 'paid'.
export function providerPaymentStatus(payment) {
  if (payment?.status === 'refunded') return 'refunded';
  if (payment?.status === 'captured') return payment.amount_refunded > 0 ? 'refunded' : 'paid';
  if (payment?.status === 'failed') return 'failed';
  return null;
}

// Rupees typed in Admin → whole paise. Rejects fractions of a paisa instead of silently rounding them.
export function refundPaise(value) {
  const rupees = typeof value === 'string' ? Number(value.trim()) : value;
  if (typeof rupees !== 'number' || !Number.isFinite(rupees) || rupees <= 0 || rupees > 10000000) throw new Error('Enter the amount to refund');
  const paise = Math.round(rupees * 100);
  if (Math.abs(rupees * 100 - paise) > 1e-6) throw new Error('Refund amounts can have at most two decimals');
  return paise;
}

// A 4xx from Razorpay means it refused the request. Timeouts, 429 and 5xx are ambiguous: the refund may exist.
export const refundRejected = error => Number.isInteger(error?.status) && error.status >= 400 && error.status < 500 && error.status !== 429;

export const refundStatus = refund => ['pending', 'processed', 'failed'].includes(refund?.status) ? refund.status : 'pending';

// Our refund row id is the Razorpay receipt, so this finds a refund an earlier, unconfirmed attempt created.
export const matchingRefund = (collection, receipt) => (collection?.items || []).find(refund => refund.receipt === receipt) || null;
