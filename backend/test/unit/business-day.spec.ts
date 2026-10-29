import { businessDate, gramsToMg, mgToGrams } from '../../src/common/business-day';

describe('business day', () => {
  it('uses the store time zone, not UTC', () => {
    // 03:00 UTC on the 28th is still 10 p.m. on the 27th in Bogotá (UTC-5).
    const lateEvening = new Date('2026-10-28T03:00:00Z');

    expect(businessDate('America/Bogota', lateEvening)).toBe('2026-10-27');
    expect(businessDate('UTC', lateEvening)).toBe('2026-10-28');
  });

  it('converts grams to integer milligrams without floating point drift', () => {
    expect(gramsToMg(3.5)).toBe(3500);
    expect(gramsToMg(0.1 + 0.2)).toBe(300);
    expect(gramsToMg(12.345)).toBe(12345);
    expect(mgToGrams(12345)).toBe(12.345);
  });
});
