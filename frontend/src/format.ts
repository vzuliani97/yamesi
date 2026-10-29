const currency = new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 });

export const formatCop = (value: number) => currency.format(value);
export const formatGrams = (grams: number) => `${grams.toLocaleString('es-CO', { maximumFractionDigits: 3 })} g`;

export const PAYMENT_LABELS = { CASH: 'Efectivo', CARD: 'Tarjeta', TRANSFER: 'Transferencia' } as const;
export const CATEGORIES = ['ANILLO', 'CADENA', 'ARETES', 'PULSERA', 'DIJE', 'OTRO'] as const;
export const EXPENSE_CATEGORIES = ['TRANSPORTE', 'ASEO', 'PAPELERIA', 'MANTENIMIENTO', 'OTRO'] as const;

export const titleCase = (value: string) => value.charAt(0) + value.slice(1).toLowerCase();
