import PDFDocument from 'pdfkit';

export interface InvoicePdfData {
  number: number;
  businessDate: string;
  customerName: string;
  customerDocument: string | null;
  paymentMethod: 'CASH' | 'CARD' | 'TRANSFER';
  sellerName: string;
  total: number;
  items: Array<{ sku: string; name: string; karat: number; grams: number; price: number }>;
}

const PAYMENT_LABELS = { CASH: 'Efectivo', CARD: 'Tarjeta', TRANSFER: 'Transferencia' } as const;
const cop = new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 });

/** Renders the sale receipt as a PDF in memory. */
export function renderInvoicePdf(data: InvoicePdfData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 50, info: { Title: `Factura ${data.number}` } });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(20).text('Joyería Yamesi');
    doc.fontSize(9).fillColor('#666').text('Documento de demostración con datos ficticios. No es una factura electrónica.');
    doc.moveDown();

    doc.fillColor('#000').fontSize(14).text(`Factura de venta N.º ${String(data.number).padStart(6, '0')}`);
    doc.fontSize(10);
    doc.text(`Fecha: ${data.businessDate}`);
    doc.text(`Cliente: ${data.customerName}${data.customerDocument ? ` · Doc. ${data.customerDocument}` : ''}`);
    doc.text(`Forma de pago: ${PAYMENT_LABELS[data.paymentMethod]}`);
    doc.text(`Atendido por: ${data.sellerName}`);
    doc.moveDown();

    const columns = [50, 120, 330, 390, 450];
    const header = ['Código', 'Pieza', 'Kilates', 'Gramos', 'Valor'];
    let y = doc.y;
    doc.font('Helvetica-Bold');
    header.forEach((title, i) => doc.text(title, columns[i], y));
    doc.font('Helvetica');
    y += 18;

    for (const item of data.items) {
      doc.text(item.sku, columns[0], y);
      doc.text(item.name, columns[1], y, { width: 200 });
      doc.text(`${item.karat}k`, columns[2], y);
      doc.text(item.grams.toFixed(3), columns[3], y);
      doc.text(cop.format(item.price), columns[4], y);
      y += 18;
    }

    doc.moveTo(50, y + 4).lineTo(560, y + 4).stroke();
    doc.font('Helvetica-Bold').fontSize(12).text(`Total: ${cop.format(data.total)}`, columns[3], y + 12);
    doc.end();
  });
}
