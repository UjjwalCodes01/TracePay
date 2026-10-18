/**
 * Money is always an integer number of minor units (cents). Never use floats
 * for amounts; convert only at the edges (PayPal strings, UI display).
 */
export type Cents = number;

export const SUPPORTED_CURRENCY = 'USD' as const;
export type Currency = typeof SUPPORTED_CURRENCY;

export function assertCents(value: number, label = 'amount'): asserts value is Cents {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative integer number of cents, got ${value}`);
  }
}

/** "20.00" | "20" | "0.5" -> 2000 | 2000 | 50. Rejects more than 2 decimals. */
export function decimalToCents(value: string): Cents {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) throw new RangeError(`Invalid decimal amount: "${value}"`);
  const whole = Number(match[1]);
  const frac = Number((match[2] ?? '').padEnd(2, '0'));
  const cents = whole * 100 + frac;
  assertCents(cents);
  return cents;
}

/** 2000 -> "20.00" — the format PayPal expects in `amount.value`. */
export function centsToDecimal(cents: Cents): string {
  assertCents(cents);
  const whole = Math.floor(cents / 100);
  const frac = cents % 100;
  return `${whole}.${frac.toString().padStart(2, '0')}`;
}

export function formatMoney(cents: Cents, currency: Currency = SUPPORTED_CURRENCY): string {
  return `${currency === 'USD' ? '$' : `${currency} `}${centsToDecimal(cents)}`;
}

/** Basis points: 2500 bps = 25%. */
export function formatBps(bps: number): string {
  return `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;
}
