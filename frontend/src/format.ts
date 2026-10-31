const currency = new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 });

export const formatCop = (value: number) => currency.format(value);
export const formatGrams = (grams: number) => `${grams.toLocaleString('es-CO', { maximumFractionDigits: 3 })} g`;

export const PAYMENT_LABELS = { CASH: 'Efectivo', CARD: 'Tarjeta', TRANSFER: 'Transferencia' } as const;
export const DOCUMENT_LABELS = { CC: 'Cédula de ciudadanía', CE: 'Cédula de extranjería', NIT: 'NIT', PP: 'Pasaporte' } as const;

/** Must match VAT_RATE_PERCENT on the API. Only for the live preview: the issued invoice from the API is authoritative. */
export const VAT_RATE = 19;

/** Same split as the API: prices include VAT; base + VAT always equals the price. */
export function splitVat(price: number, rate = VAT_RATE) {
  const taxBase = Math.round((price * 100) / (100 + rate));
  return { taxBase, vat: price - taxBase };
}
export const CATEGORIES = ['ANILLO', 'CADENA', 'ARETES', 'PULSERA', 'DIJE', 'OTRO'] as const;
export const EXPENSE_CATEGORIES = ['TRANSPORTE', 'ASEO', 'PAPELERIA', 'MANTENIMIENTO', 'OTRO'] as const;

export const titleCase = (value: string) => value.charAt(0) + value.slice(1).toLowerCase();
