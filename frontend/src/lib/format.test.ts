import { describe, expect, it } from 'vitest';
import { ago, money, pct, price, priceDecimals, qty, signed, tone, words } from './format';

describe('format', () => {
  it('chooses price precision from magnitude', () => {
    expect(priceDecimals(63204.2)).toBe(2);
    expect(priceDecimals(1.12316)).toBe(5);
    expect(price(63204.2)).toBe('63,204.20');
    expect(price(1.123164)).toBe('1.12316');
    expect(price(null)).toBe('—');
    expect(price(Number.NaN)).toBe('—');
  });

  it('signs money and percentages with a real minus', () => {
    expect(money(-12.5, 'USD')).toBe('−12.50 USD');
    expect(money(12.5, 'USD', { sign: true })).toBe('+12.50 USD');
    expect(pct(-1.234)).toBe('−1.23%');
    expect(signed(3)).toBe('+3.00');
  });

  it('formats quantities and words', () => {
    expect(qty(0.0012345)).toBe('0.001235');
    expect(words('trend_pullback')).toBe('Trend pullback');
    expect(words(null)).toBe('—');
  });

  it('tones profit and loss', () => {
    expect(tone(1)).toBe('up');
    expect(tone(-1)).toBe('down');
    expect(tone(0)).toBe('');
  });

  it('describes elapsed time', () => {
    const now = 1_000_000_000;
    expect(ago(now - 5_000, now)).toBe('just now');
    expect(ago(now - 120_000, now)).toBe('2 min ago');
    expect(ago(null, now)).toBe('never');
  });
});
