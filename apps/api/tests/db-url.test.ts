import { describe, expect, it } from 'vitest';
import { withVerifiedTls } from '../src/db';

describe('withVerifiedTls', () => {
  it('pins verify-full for the sslmode Neon connection strings use', () => {
    const url = 'postgresql://u:p@ep-x-pooler.us-east-2.aws.neon.tech/neondb?channel_binding=require&sslmode=require';
    const out = new URL(withVerifiedTls(url));
    expect(out.searchParams.get('sslmode')).toBe('verify-full');
    expect(out.searchParams.get('channel_binding')).toBe('require');
    expect(out.hostname).toBe('ep-x-pooler.us-east-2.aws.neon.tech');
  });

  it('leaves local, already-strict and explicit libpq-compat URLs alone', () => {
    const local = 'postgresql://tracepay:tracepay@localhost:5433/tracepay';
    expect(withVerifiedTls(local)).toBe(local);
    const strict = 'postgresql://u:p@h/db?sslmode=verify-full';
    expect(withVerifiedTls(strict)).toBe(strict);
    const compat = 'postgresql://u:p@h/db?uselibpqcompat=true&sslmode=require';
    expect(withVerifiedTls(compat)).toBe(compat);
  });
});
