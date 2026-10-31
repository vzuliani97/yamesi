import { createHash } from 'node:crypto';

/** Inputs of the CUFE, named as in Resolución DIAN 000165 de 2023, Anexo Técnico, section 11.1.6.1. */
export interface CufeInput {
  numFac: string; // prefix + number, e.g. FV12
  fecFac: string; // YYYY-MM-DD
  horFac: string; // HH:MM:SS-05:00
  valFac: string; // total before taxes, e.g. 1500000.00
  valImp1: string; // VAT (code 01)
  valImp2: string; // national consumption tax (code 04)
  valImp3: string; // ICA (code 03)
  valTot: string; // total with taxes
  nitOfe: string; // issuer NIT without check digit
  numAdq: string; // buyer id without check digit
  clTec: string; // technical key of the numbering range
  tipoAmbiente: '1' | '2'; // 1 production, 2 test
}

/** SHA-384 over the concatenated fields, in the order fixed by the annex. */
export function computeCufe(input: CufeInput): string {
  const chain =
    input.numFac + input.fecFac + input.horFac + input.valFac +
    '01' + input.valImp1 + '04' + input.valImp2 + '03' + input.valImp3 +
    input.valTot + input.nitOfe + input.numAdq + input.clTec + input.tipoAmbiente;
  return createHash('sha384').update(chain, 'utf8').digest('hex');
}

const QR_BASE_URL = {
  '1': 'https://catalogo-vpfe.dian.gov.co/document/searchqr?documentkey=',
  '2': 'https://catalogo-vpfe-hab.dian.gov.co/document/searchqr?documentkey=',
} as const;

/** Text encoded in the QR of the graphic representation (annex, section 11.1.7). `valOtroIm` = taxes other than VAT. */
export function qrContent(input: CufeInput, cufe: string, valOtroIm: string): string {
  return [
    `NumFac: ${input.numFac}`,
    `FecFac: ${input.fecFac}`,
    `HorFac: ${input.horFac}`,
    `NitFac: ${input.nitOfe}`,
    `DocAdq: ${input.numAdq}`,
    `ValFac: ${input.valFac}`,
    `ValIva: ${input.valImp1}`,
    `ValOtroIm: ${valOtroIm}`,
    `ValTolFac: ${input.valTot}`,
    `CUFE: ${cufe}`,
    `${QR_BASE_URL[input.tipoAmbiente]}${cufe}`,
  ].join('\n');
}
