import { describe, expect, it } from 'vitest';
import { ApiError, errorText, humanMessage, url } from './api';

describe('api helpers', () => {
  it('builds query strings and drops empty values', () => {
    expect(url('/api/x', { a: 1, b: '', c: null, d: 'y z' })).toBe('/api/x?a=1&d=y+z');
    expect(url('/api/x')).toBe('/api/x');
  });

  it('turns backend messages into sentences', () => {
    expect(humanMessage(400, 'BAD', 'stop must be a number')).toBe('Stop must be a number');
    expect(humanMessage(0, 'NETWORK', '')).toMatch(/could not be reached/);
    expect(humanMessage(500, 'INTERNAL', 'internal error')).toMatch(/server hit an error/);
  });

  it('explains risk-gate refusals with their reasons', () => {
    const e = new ApiError(422, 'RISK_REJECTED', 'Risk gate rejected', { reasons: ['max open positions (3) reached'] });
    expect(errorText(e)).toBe('The risk gate refused this order: max open positions (3) reached.');
  });
});
