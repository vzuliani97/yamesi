import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { AppConfig } from '../config';
import { pesosInWords } from './amount-in-words';
import { CufeInput, qrContent } from './cufe';

export interface InvoicePdfItem {
  sku: string;
  reference: string | null;
  size: string | null;
  name: string;
  karat: number;
  grams: number;
  vatRate: number;
  taxBase: number;
  vat: number;
  price: number;
  /** JPEG photo of the piece, printed on its line. */
  photo?: Buffer | null;
}

export interface InvoicePdfData {
  config: Pick<
    AppConfig,
    | 'STORE_NAME'
    | 'STORE_LEGAL_NAME'
    | 'STORE_NIT'
    | 'STORE_TAX_REGIME'
    | 'STORE_ADDRESS'
    | 'STORE_PHONE'
    | 'STORE_EMAIL'
    | 'VAT_RATE_PERCENT'
    | 'INVOICE_PREFIX'
    | 'DIAN_RESOLUTION_NUMBER'
    | 'DIAN_RESOLUTION_DATE'
    | 'DIAN_RESOLUTION_VALID_UNTIL'
    | 'DIAN_RANGE_FROM'
    | 'DIAN_RANGE_TO'
    | 'GOLD_WARRANTY_TEXT'
  >;
  fullNumber: string;
  issuedDate: string;
  issuedTime: string;
  customer: {
    name: string;
    documentType: string | null;
    document: string | null;
    email: string | null;
    phone: string | null;
    address: string | null;
  };
  paymentMethod: 'CASH' | 'CARD' | 'TRANSFER';
  paymentReference: string | null;
  sellerName: string;
  subtotal: number;
  vatTotal: number;
  total: number;
  items: InvoicePdfItem[];
  cufe: string;
  cufeInput: CufeInput;
}

const PAYMENT_LABELS = { CASH: 'Efectivo', CARD: 'Tarjeta débito/crédito', TRANSFER: 'Transferencia bancaria' } as const;
const DOCUMENT_LABELS: Record<string, string> = { CC: 'C.C.', CE: 'C.E.', NIT: 'NIT', PP: 'Pasaporte' };
// Gold fineness ("ley") in thousandths for the usual karats.
const FINENESS: Record<number, number> = { 18: 750, 14: 585, 10: 417 };

const COLOR = { ink: '#1c1917', muted: '#57534e', line: '#e7e5e4', band: '#1c1917', gold: '#b45309', goldSoft: '#fdf6e3', zebra: '#fafaf9' };
const PAGE = { left: 40, right: 572, width: 532, footerTop: 650 };

const cop = new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 });
const grams = new Intl.NumberFormat('es-CO', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
const integer = new Intl.NumberFormat('es-CO');

const fineness = (karat: number) => FINENESS[karat] ?? Math.round((karat / 24) * 1000);
/** 900123456-7 -> 900.123.456-7 (string-based, so leading zeros survive). */
const nitLabel = (nit: string) => {
  const [body, checkDigit] = nit.split('-');
  return `${body.replace(/\B(?=(\d{3})+(?!\d))/g, '.')}-${checkDigit}`;
};

/**
 * Draws the QR as vector squares from its module matrix. Embedding a PNG made PDFKit decode it in pure
 * JavaScript on every invoice (about 300 ms); vectors are faster and print sharper. Runs of dark modules
 * in a row become one rectangle, and everything is filled as a single path.
 */
function drawQr(doc: PDFKit.PDFDocument, modules: { size: number; get(row: number, col: number): number | boolean }, x: number, y: number, size: number) {
  const n = modules.size;
  const cell = size / (n + 2); // one-module quiet zone on each side
  doc.save().rect(x, y, size, size).fill('#ffffff').fillColor('#000000');
  for (let row = 0; row < n; row += 1) {
    let col = 0;
    while (col < n) {
      if (!modules.get(row, col)) {
        col += 1;
        continue;
      }
      let end = col;
      while (end + 1 < n && modules.get(row, end + 1)) end += 1;
      // A hair of overlap avoids hairline gaps between rows in some PDF viewers.
      doc.rect(x + (col + 1) * cell, y + (row + 1) * cell, (end - col + 1) * cell + 0.05, cell + 0.05);
      col = end + 1;
    }
  }
  doc.fill().restore();
}

/** Renders the graphic representation of the sales invoice. Every page carries the QR and the CUFE, as the DIAN annex requires. */
export function renderInvoicePdf(data: InvoicePdfData): Promise<Buffer> {
  const qr = QRCode.create(qrContent(data.cufeInput, data.cufe, '0.00'), { errorCorrectionLevel: 'M' });

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'LETTER',
      margin: 40,
      bufferPages: true,
      info: { Title: `Factura electrónica de venta ${data.fullNumber}`, Author: data.config.STORE_LEGAL_NAME },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const c = data.config;

    // ---- Header band ----
    const drawHeader = () => {
      doc.rect(0, 0, 612, 96).fill(COLOR.band);
      doc.fillColor('#f5d78e').font('Helvetica-Bold').fontSize(22).text(c.STORE_NAME.toUpperCase(), PAGE.left, 26, { width: 300, characterSpacing: 1.5 });
      doc.fillColor('#e7e5e4').font('Helvetica').fontSize(8.5);
      doc.text(c.STORE_LEGAL_NAME, PAGE.left, 54, { width: 300 });
      doc.text(`NIT ${nitLabel(c.STORE_NIT)} · ${c.STORE_TAX_REGIME}`, PAGE.left, 66, { width: 300 });
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(10).text('FACTURA ELECTRÓNICA DE VENTA', 330, 28, { width: 242, align: 'right' });
      doc.fillColor('#f5d78e').fontSize(20).text(`N.º ${data.fullNumber}`, 330, 44, { width: 242, align: 'right' });
      doc.fillColor('#d6d3d1').font('Helvetica').fontSize(8).text('Representación gráfica · Ambiente de pruebas', 330, 70, { width: 242, align: 'right' });
    };

    drawHeader();

    // ---- Issuer, issue and buyer blocks ----
    const blockTop = 112;
    const block = (x: number, width: number, title: string, rows: Array<[string, string]>) => {
      doc.fillColor(COLOR.gold).font('Helvetica-Bold').fontSize(7.5).text(title.toUpperCase(), x, blockTop, { width, characterSpacing: 0.8 });
      let y = blockTop + 13;
      for (const [label, value] of rows) {
        doc.fillColor(COLOR.muted).font('Helvetica').fontSize(7.5).text(label, x, y, { width });
        y = doc.y;
        doc.fillColor(COLOR.ink).font('Helvetica').fontSize(8.5).text(value, x, y, { width });
        y = doc.y + 4;
      }
      return y;
    };

    const buyerId = data.customer.document
      ? `${DOCUMENT_LABELS[data.customer.documentType ?? ''] ?? 'Doc.'} ${data.customer.document}`
      : 'Consumidor final · 222222222222';
    const payment: Array<[string, string]> = [
      ['Fecha y hora de expedición', `${data.issuedDate} · ${data.issuedTime}`],
      ['Fecha de vencimiento', data.issuedDate],
      ['Forma de pago', 'Contado'],
      ['Medio de pago', PAYMENT_LABELS[data.paymentMethod] + (data.paymentReference ? ` · Ref. ${data.paymentReference}` : '')],
    ];
    const buyer: Array<[string, string]> = [
      ['Nombre o razón social', data.customer.name],
      ['Identificación', buyerId],
      ['Correo electrónico', data.customer.email ?? 'No suministrado'],
      ['Teléfono', data.customer.phone ?? 'No suministrado'],
    ];
    if (data.customer.address) buyer.push(['Dirección', data.customer.address]);

    const ends = [
      block(PAGE.left, 160, 'Emisor', [
        ['Dirección', c.STORE_ADDRESS],
        ['Teléfono', c.STORE_PHONE],
        ['Correo electrónico', c.STORE_EMAIL],
      ]),
      block(212, 170, 'Expedición y pago', payment),
      block(398, 174, 'Adquiriente', buyer),
    ];
    let y = Math.max(...ends) + 4;

    doc.fillColor(COLOR.muted).font('Helvetica').fontSize(7).text(
      `Autorización de numeración de facturación: Resolución DIAN N.º ${c.DIAN_RESOLUTION_NUMBER} del ${c.DIAN_RESOLUTION_DATE}, ` +
        `prefijo ${c.INVOICE_PREFIX}, del ${integer.format(c.DIAN_RANGE_FROM)} al ${integer.format(c.DIAN_RANGE_TO)}, vigente hasta ${c.DIAN_RESOLUTION_VALID_UNTIL}.`,
      PAGE.left,
      y,
      { width: PAGE.width },
    );
    y = doc.y + 10;

    // ---- Items table ----
    const cols = [
      { title: '#', x: 40, w: 18, align: 'left' as const },
      { title: 'Referencia', x: 60, w: 68, align: 'left' as const },
      { title: 'Descripción', x: 130, w: 182, align: 'left' as const },
      { title: 'Cant.', x: 314, w: 28, align: 'center' as const },
      { title: 'Valor unitario', x: 344, w: 76, align: 'right' as const },
      { title: `IVA ${c.VAT_RATE_PERCENT} %`, x: 422, w: 70, align: 'right' as const },
      { title: 'Total', x: 494, w: 78, align: 'right' as const },
    ];
    const tableHeader = () => {
      doc.rect(PAGE.left, y, PAGE.width, 20).fill(COLOR.band);
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(8);
      for (const col of cols) doc.text(col.title, col.x + 3, y + 6, { width: col.w - 6, align: col.align });
      y += 20;
    };
    tableHeader();

    // Lines grow to fit a photo when at least one piece has one.
    const withPhotos = data.items.some((item) => item.photo);
    const photoSize = 34;
    data.items.forEach((item, index) => {
      const rowHeight = withPhotos ? photoSize + 8 : 30;
      if (y + rowHeight > PAGE.footerTop - 10) {
        doc.addPage();
        drawHeader();
        y = 112;
        tableHeader();
      }
      if (index % 2 === 1) doc.rect(PAGE.left, y, PAGE.width, rowHeight).fill(COLOR.zebra);
      const cells = [
        String(index + 1),
        item.reference ?? item.sku,
        null,
        '1',
        cop.format(item.taxBase),
        cop.format(item.vat),
        cop.format(item.price),
      ];
      doc.font('Helvetica').fontSize(8.5).fillColor(COLOR.ink);
      cells.forEach((value, i) => {
        if (value !== null) doc.text(value, cols[i].x + 3, withPhotos ? y + rowHeight / 2 - 4 : y + 7, { width: cols[i].w - 6, align: cols[i].align, lineBreak: false, ellipsis: true });
      });
      const description = item.name;
      let textX = cols[2].x + 3;
      if (item.photo) {
        doc.save();
        doc.roundedRect(textX, y + 4, photoSize, photoSize, 4).clip();
        doc.image(item.photo, textX, y + 4, { cover: [photoSize, photoSize], align: 'center', valign: 'center' });
        doc.restore();
      }
      if (withPhotos) textX += photoSize + 6;
      const textWidth = cols[2].w - 6 - (textX - cols[2].x - 3);
      // With photos, the two text lines sit centered next to the picture.
      const textTop = withPhotos ? y + rowHeight / 2 - 11 : y + 5;
      // One line at most: a long catalog name is cut with an ellipsis instead of running into the weight line.
      doc.font('Helvetica-Bold').fontSize(8.5).text(description, textX, textTop, { width: textWidth, height: 10, ellipsis: true });
      doc.font('Helvetica').fontSize(7.5).fillColor(COLOR.muted)
        // With a catalog reference in its own column, the piece's serial identifies the exact unit sold.
        .text(`Oro ${item.karat}k · ley ${fineness(item.karat)} · ${grams.format(item.grams)} g${item.size ? ` · ${item.size}` : ''}${item.reference ? ` · ${item.sku}` : ''}`, textX, textTop + 12, { width: textWidth });
      doc.moveTo(PAGE.left, y + rowHeight).lineTo(PAGE.right, y + rowHeight).lineWidth(0.5).strokeColor(COLOR.line).stroke();
      y += rowHeight;
    });

    // ---- Words, gold weight and totals ----
    if (y + 150 > PAGE.footerTop) {
      doc.addPage();
      drawHeader();
      y = 112;
    }
    y += 12;
    const totalGrams = data.items.reduce((sum, item) => sum + item.grams, 0);
    doc.fillColor(COLOR.muted).font('Helvetica').fontSize(7.5).text('VALOR EN LETRAS', PAGE.left, y);
    doc.fillColor(COLOR.ink).font('Helvetica-Bold').fontSize(9).text(pesosInWords(data.total), PAGE.left, y + 11, { width: 300 });
    doc.fillColor(COLOR.muted).font('Helvetica').fontSize(7.5).text('PESO TOTAL DE ORO', PAGE.left, doc.y + 8);
    doc.fillColor(COLOR.ink).font('Helvetica').fontSize(9).text(`${grams.format(totalGrams)} g en ${data.items.length} pieza(s)`, PAGE.left, doc.y + 2);
    doc.fillColor(COLOR.muted).fontSize(7.5).text(`Atendido por: ${data.sellerName}`, PAGE.left, doc.y + 8);
    const leftEnd = doc.y;

    const totalsX = 360;
    const totalsRow = (label: string, value: string, rowY: number) => {
      doc.fillColor(COLOR.muted).font('Helvetica').fontSize(8.5).text(label, totalsX, rowY, { width: 110 });
      doc.fillColor(COLOR.ink).font('Helvetica').fontSize(8.5).text(value, totalsX + 110, rowY, { width: 102, align: 'right' });
    };
    totalsRow('Subtotal (base gravable)', cop.format(data.subtotal), y);
    totalsRow(`IVA ${c.VAT_RATE_PERCENT} %`, cop.format(data.vatTotal), y + 16);
    totalsRow('Descuentos', cop.format(0), y + 32);
    doc.rect(totalsX, y + 50, 212, 28).fill(COLOR.band);
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(9).text('TOTAL A PAGAR', totalsX + 10, y + 60, { width: 90 });
    doc.fillColor('#f5d78e').fontSize(13).text(cop.format(data.total), totalsX + 96, y + 57, { width: 106, align: 'right' });
    y = Math.max(leftEnd, y + 78) + 16;

    // ---- Lifetime gold warranty ----
    doc.font('Helvetica').fontSize(8.5);
    const warrantyHeight = doc.heightOfString(c.GOLD_WARRANTY_TEXT, { width: PAGE.width - 24 }) + 30;
    doc.roundedRect(PAGE.left, y, PAGE.width, warrantyHeight, 6).fillAndStroke(COLOR.goldSoft, '#e9c46a');
    doc.fillColor(COLOR.gold).font('Helvetica-Bold').fontSize(9).text('GARANTÍA DE POR VIDA DEL ORO', PAGE.left + 12, y + 9);
    doc.fillColor(COLOR.ink).font('Helvetica').fontSize(8.5).text(c.GOLD_WARRANTY_TEXT, PAGE.left + 12, y + 22, { width: PAGE.width - 24 });

    // ---- Footer on every page: QR, CUFE, legal note, page number ----
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i += 1) {
      doc.switchToPage(i);
      const top = PAGE.footerTop;
      doc.moveTo(PAGE.left, top).lineTo(PAGE.right, top).lineWidth(0.75).strokeColor(COLOR.line).stroke();
      drawQr(doc, qr.modules, PAGE.left, top + 10, 86);
      const textX = PAGE.left + 100;
      doc.fillColor(COLOR.muted).font('Helvetica-Bold').fontSize(7).text('CUFE', textX, top + 12);
      doc.fillColor(COLOR.ink).font('Courier').fontSize(7).text(data.cufe, textX, top + 22, { width: PAGE.width - 100 });
      doc.fillColor(COLOR.muted).font('Helvetica').fontSize(7).text(
        'Representación gráfica de la factura electrónica de venta. Generada en ambiente de pruebas: no ha sido transmitida ' +
          'ni validada por la DIAN y no tiene validez fiscal. El código QR contiene los datos del documento y la URL de consulta de la DIAN.',
        textX,
        top + 46,
        { width: PAGE.width - 100 },
      );
      doc.text(`Software: Yamesi Core · Página ${i - range.start + 1} de ${range.count}`, textX, top + 84, { width: PAGE.width - 100 });
    }

    doc.end();
  });
}
