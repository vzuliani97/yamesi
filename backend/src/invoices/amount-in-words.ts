// Invoices in Colombia usually state the total in words ("SON: ... PESOS M/CTE"), so a reader can spot an altered figure.
const UNITS = ['', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve', 'diez', 'once', 'doce',
  'trece', 'catorce', 'quince', 'dieciséis', 'diecisiete', 'dieciocho', 'diecinueve', 'veinte', 'veintiuno', 'veintidós',
  'veintitrés', 'veinticuatro', 'veinticinco', 'veintiséis', 'veintisiete', 'veintiocho', 'veintinueve'];
const TENS = ['', '', '', 'treinta', 'cuarenta', 'cincuenta', 'sesenta', 'setenta', 'ochenta', 'noventa'];
const HUNDREDS = ['', 'ciento', 'doscientos', 'trescientos', 'cuatrocientos', 'quinientos', 'seiscientos', 'setecientos',
  'ochocientos', 'novecientos'];

/** 0-999. `apocope` turns a final "uno" into "un" before a noun: "veintiún mil", "un millón". */
function belowThousand(n: number, apocope: boolean): string {
  if (n === 100) return 'cien';
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  let words: string;
  if (rest < 30) {
    words = UNITS[rest];
  } else {
    const unit = rest % 10;
    words = TENS[Math.floor(rest / 10)] + (unit ? ` y ${UNITS[unit]}` : '');
  }
  if (apocope) {
    words = words.replace(/veintiuno$/, 'veintiún').replace(/uno$/, 'un');
  }
  return [HUNDREDS[hundreds], words].filter(Boolean).join(' ');
}

/** 0-999,999 */
function belowMillion(n: number, apocope: boolean): string {
  const thousands = Math.floor(n / 1000);
  const rest = n % 1000;
  const head = thousands === 0 ? '' : thousands === 1 ? 'mil' : `${belowThousand(thousands, true)} mil`;
  return [head, belowThousand(rest, apocope)].filter(Boolean).join(' ');
}

/** Whole pesos in Spanish, e.g. 3000000 -> "TRES MILLONES DE PESOS M/CTE". */
export function pesosInWords(amount: number): string {
  if (!Number.isInteger(amount) || amount < 0 || amount >= 1e12) {
    throw new RangeError('amount must be an integer between 0 and 999,999,999,999');
  }
  if (amount === 0) return 'CERO PESOS M/CTE';
  if (amount === 1) return 'UN PESO M/CTE';

  const millions = Math.floor(amount / 1e6);
  const rest = amount % 1e6;
  const parts: string[] = [];
  if (millions > 0) {
    parts.push(millions === 1 ? 'un millón' : `${belowMillion(millions, true)} millones`);
  }
  if (rest > 0) {
    parts.push(belowMillion(rest, true));
  }
  // "un millón de pesos" but "un millón quinientos mil pesos".
  const connector = millions > 0 && rest === 0 ? ' de' : '';
  return `${parts.join(' ')}${connector} pesos m/cte`.toUpperCase();
}
