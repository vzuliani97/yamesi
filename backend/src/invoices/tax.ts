/**
 * Colombian retail prices include VAT (Ley 1480 de 2011 requires the final price to be shown).
 * The invoice must discriminate it, so each line price is split into a taxable base and the VAT,
 * in whole pesos, with base + VAT always equal to the price that was charged.
 */
export function splitVat(priceWithVat: number, ratePercent: number): { taxBase: number; vat: number } {
  const taxBase = Math.round((priceWithVat * 100) / (100 + ratePercent));
  return { taxBase, vat: priceWithVat - taxBase };
}

/** Amount format required by the DIAN technical annex: point decimal, two decimals, no thousands separator. */
export function dianAmount(pesos: number): string {
  return `${pesos}.00`;
}
