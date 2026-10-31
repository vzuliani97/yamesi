import { pesosInWords } from '../../src/invoices/amount-in-words';
import { computeCufe, qrContent } from '../../src/invoices/cufe';
import { dianAmount, splitVat } from '../../src/invoices/tax';

describe('Colombian invoice rules', () => {
  it('reproduces the CUFE of the official example in Resolución DIAN 000165 de 2023 (annex 11.1.6.1)', () => {
    const input = {
      numFac: '323200000129',
      fecFac: '2019-01-16',
      horFac: '10:53:10-05:00',
      valFac: '1500000.00',
      valImp1: '285000.00',
      valImp2: '0.00',
      valImp3: '0.00',
      valTot: '1785000.00',
      nitOfe: '700085371',
      numAdq: '800199436',
      clTec: '693ff6f2a553c3646a063436fd4dd9ded0311471',
      tipoAmbiente: '1' as const,
    };

    const cufe = computeCufe(input);

    expect(cufe).toBe('8bb918b19ba22a694f1da11c643b5e9de39adf60311cf179179e9b33381030bcd4c3c3f156c506ed5908f9276f5bd9b4');
    expect(qrContent({ ...input, tipoAmbiente: '2' }, cufe, '0.00')).toContain(
      `https://catalogo-vpfe-hab.dian.gov.co/document/searchqr?documentkey=${cufe}`,
    );
  });

  it('splits a VAT-inclusive price into base and 19% VAT that add up to the price', () => {
    expect(splitVat(1_190_000, 19)).toEqual({ taxBase: 1_000_000, vat: 190_000 });
    expect(splitVat(1_650_000, 19)).toEqual({ taxBase: 1_386_555, vat: 263_445 });
    for (const price of [1, 7, 99_999, 1_350_000, 5_200_000]) {
      const { taxBase, vat } = splitVat(price, 19);
      expect(taxBase + vat).toBe(price);
    }
    expect(dianAmount(1_386_555)).toBe('1386555.00');
  });

  it.each([
    [1, 'UN PESO M/CTE'],
    [21, 'VEINTIÚN PESOS M/CTE'],
    [100, 'CIEN PESOS M/CTE'],
    [101, 'CIENTO UN PESOS M/CTE'],
    [1_000, 'MIL PESOS M/CTE'],
    [21_000, 'VEINTIÚN MIL PESOS M/CTE'],
    [1_000_000, 'UN MILLÓN DE PESOS M/CTE'],
    [1_650_000, 'UN MILLÓN SEISCIENTOS CINCUENTA MIL PESOS M/CTE'],
    [3_000_000, 'TRES MILLONES DE PESOS M/CTE'],
    [4_150_000, 'CUATRO MILLONES CIENTO CINCUENTA MIL PESOS M/CTE'],
    [21_345_678, 'VEINTIÚN MILLONES TRESCIENTOS CUARENTA Y CINCO MIL SEISCIENTOS SETENTA Y OCHO PESOS M/CTE'],
  ])('writes %i as "%s"', (amount, words) => {
    expect(pesosInWords(amount)).toBe(words);
  });
});
