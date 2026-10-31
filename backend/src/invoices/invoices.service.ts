import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { AuditService } from '../audit/audit.module';
import { AuthUser } from '../auth/auth.types';
import { AppError } from '../common/app-error';
import { assertDayOpen, businessDate, lockDayShared, mgToGrams } from '../common/business-day';
import { APP_CONFIG, AppConfig } from '../config';
import { DatabaseService } from '../database/database.service';
import { FILE_STORAGE, FileStorage } from '../storage/storage.module';
import { computeCufe, CufeInput } from './cufe';
import { renderInvoicePdf } from './invoice-pdf';
import { dianAmount, splitVat } from './tax';

export type PaymentMethod = 'CASH' | 'CARD' | 'TRANSFER';
export type DocumentType = 'CC' | 'CE' | 'NIT' | 'PP';

export interface CreateInvoiceInput {
  customerName: string;
  customerDocumentType?: DocumentType;
  customerDocument?: string;
  customerEmail?: string;
  customerPhone?: string;
  customerAddress?: string;
  paymentMethod: PaymentMethod;
  paymentReference?: string;
  pieceIds: number[];
}

/** Buyer id used by the DIAN when the customer gives no document ("consumidor final"). */
export const FINAL_CONSUMER_ID = '222222222222';

interface InvoiceRow {
  id: string;
  number: number;
  business_date: string;
  customer_name: string;
  customer_document_type: DocumentType | null;
  customer_document: string | null;
  customer_email: string | null;
  customer_phone: string | null;
  customer_address: string | null;
  payment_method: PaymentMethod;
  payment_reference: string | null;
  subtotal: number;
  vat_total: number;
  total: number;
  issued_at: Date;
  cufe: string | null;
  pdf_key: string | null;
  seller_name: string;
  created_at: Date;
}

interface ItemRow {
  piece_id: number;
  sku: string;
  name: string;
  karat: number;
  gold_mg: number;
  price: number;
  cost: number;
  vat_rate: number;
  tax_base: number;
  vat: number;
}

const SELECT_INVOICE = `
  SELECT i.id, i.number, to_char(i.business_date, 'YYYY-MM-DD') AS business_date, i.customer_name,
         i.customer_document_type, i.customer_document, i.customer_email, i.customer_phone, i.customer_address,
         i.payment_method, i.payment_reference, i.subtotal, i.vat_total, i.total, i.issued_at, i.cufe,
         i.pdf_key, i.created_at, u.name AS seller_name
  FROM invoices i JOIN users u ON u.id = i.seller_id
`;

/** Date (YYYY-MM-DD) and time with UTC offset (HH:MM:SS-05:00) in the store's time zone, as the DIAN annex expects. */
export function dianDateTime(at: Date, timeZone: string): { date: string; time: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'longOffset',
    })
      .formatToParts(at)
      .map((part) => [part.type, part.value]),
  );
  const offset = parts.timeZoneName === 'GMT' ? '+00:00' : parts.timeZoneName.replace('GMT', '');
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}:${parts.second}${offset}` };
}

/** Buyer id for the CUFE: digits and letters only, without the NIT check digit. */
export function buyerIdForDian(type: DocumentType | null | undefined, document: string | null | undefined): string {
  if (!document) return FINAL_CONSUMER_ID;
  const withoutCheckDigit = type === 'NIT' ? document.split('-')[0] : document;
  return withoutCheckDigit.replace(/[^0-9A-Za-z]/g, '');
}

@Injectable()
export class InvoicesService {
  private readonly logger = new Logger(InvoicesService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async create(input: CreateInvoiceInput, idempotencyKey: string, seller: AuthUser) {
    const pieceIds = [...new Set(input.pieceIds)].sort((a, b) => a - b);
    const customer = {
      name: input.customerName,
      documentType: input.customerDocument ? (input.customerDocumentType ?? null) : null,
      document: input.customerDocument ?? null,
      email: input.customerEmail?.toLowerCase() ?? null,
      phone: input.customerPhone ?? null,
      address: input.customerAddress ?? null,
    };
    // Every field that ends up on the invoice is part of the hash: reusing a key with any other data is a conflict, not a replay.
    const requestHash = createHash('sha256')
      .update(JSON.stringify([customer, input.paymentMethod, input.paymentReference ?? null, pieceIds]))
      .digest('hex');
    const date = businessDate(this.config.BUSINESS_TIMEZONE);

    const result = await this.db.transaction(async (client) => {
      // Same idempotency key = same sale: concurrent retries wait here and then see the first result.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`invoice:${idempotencyKey}`]);

      const existing = await client.query<{ id: string; request_hash: string }>(
        'SELECT id, request_hash FROM invoices WHERE idempotency_key = $1',
        [idempotencyKey],
      );
      if (existing.rows.length > 0) {
        if (existing.rows[0].request_hash !== requestHash) {
          throw new AppError(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key was already used with different data');
        }
        return { id: existing.rows[0].id, replayed: true };
      }

      await lockDayShared(client, date);
      await assertDayOpen(client, date);

      // Lock the pieces in ascending id order. Two sales sharing pieces always lock them in the
      // same order, so they queue up instead of deadlocking.
      await client.query('SELECT id FROM pieces WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE', [pieceIds]);

      // Marks the pieces as sold only if they are all still in stock. A concurrent sale of the
      // same piece waited on the lock above and now finds it already SOLD.
      const sold = await client.query<Omit<ItemRow, 'vat_rate' | 'tax_base' | 'vat'>>(
        `WITH sold AS (
           UPDATE pieces SET status = 'SOLD'
           WHERE id = ANY($1::int[]) AND status = 'IN_STOCK'
           RETURNING id, sku, name, lot_id, gold_mg, labor_cost, price
         )
         SELECT s.id AS piece_id, s.sku, s.name, l.karat, s.gold_mg, s.price,
                (ROUND(s.gold_mg::numeric * l.cost_per_gram / 1000) + s.labor_cost)::int AS cost
         FROM sold s JOIN gold_lots l ON l.id = s.lot_id
         ORDER BY s.id`,
        [pieceIds],
      );

      if (sold.rows.length !== pieceIds.length) {
        const soldIds = new Set(sold.rows.map((row) => row.piece_id));
        // Throwing rolls back the pieces that were marked: the sale is all or nothing.
        throw new AppError(409, 'PIECE_NOT_AVAILABLE', 'One or more pieces are not available', {
          unavailable: pieceIds.filter((id) => !soldIds.has(id)),
        });
      }

      // Gap-free numbering: the counter row is locked until COMMIT, and a rollback undoes the increment.
      const counter = await client.query<{ last_number: number }>(
        'UPDATE invoice_counter SET last_number = last_number + 1 RETURNING last_number',
      );
      const number = counter.rows[0].last_number;
      // The DIAN authorizes a numbering range; an invoice outside it would be invalid. The rollback keeps the counter intact.
      if (number < this.config.DIAN_RANGE_FROM || number > this.config.DIAN_RANGE_TO) {
        throw new AppError(409, 'NUMBERING_RANGE_EXHAUSTED', 'The authorized invoice numbering range is used up', {
          range: { from: this.config.DIAN_RANGE_FROM, to: this.config.DIAN_RANGE_TO },
        });
      }

      const rate = this.config.VAT_RATE_PERCENT;
      const lines = sold.rows.map((row) => ({ ...row, vatRate: rate, ...splitVat(row.price, rate) }));
      const total = lines.reduce((sum, line) => sum + line.price, 0);
      const subtotal = lines.reduce((sum, line) => sum + line.taxBase, 0);
      const vatTotal = total - subtotal;

      const issuedAt = new Date();
      const { date: fecFac, time: horFac } = dianDateTime(issuedAt, this.config.BUSINESS_TIMEZONE);
      const cufe = computeCufe(this.cufeInput(number, fecFac, horFac, subtotal, vatTotal, total, customer));

      const invoice = await client.query<{ id: string }>(
        `INSERT INTO invoices (number, business_date, customer_name, customer_document_type, customer_document,
                               customer_email, customer_phone, customer_address, payment_method, payment_reference,
                               subtotal, vat_total, total, issued_at, cufe, idempotency_key, request_hash, seller_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
         RETURNING id`,
        [
          number,
          date,
          customer.name,
          customer.documentType,
          customer.document,
          customer.email,
          customer.phone,
          customer.address,
          input.paymentMethod,
          input.paymentReference ?? null,
          subtotal,
          vatTotal,
          total,
          issuedAt,
          cufe,
          idempotencyKey,
          requestHash,
          seller.id,
        ],
      );
      const invoiceId = invoice.rows[0].id;

      for (const line of lines) {
        await client.query(
          `INSERT INTO invoice_items (invoice_id, piece_id, price, cost, vat_rate, tax_base, vat)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [invoiceId, line.piece_id, line.price, line.cost, line.vatRate, line.taxBase, line.vat],
        );
      }

      await this.audit.record(client, {
        actorId: seller.id,
        action: 'INVOICE_CREATED',
        entity: 'invoice',
        entityId: invoiceId,
        data: { number, subtotal, vatTotal, total, pieceIds, paymentMethod: input.paymentMethod },
      });

      return { id: invoiceId, replayed: false };
    });

    if (!result.replayed) {
      // The PDF is generated after COMMIT. If this fails, the sale is still valid and the PDF is regenerated on download.
      await this.ensurePdf(result.id).catch((error: Error) =>
        this.logger.error(`PDF for invoice ${result.id} failed: ${error.message}`),
      );
    }

    return { invoice: await this.get(result.id), replayed: result.replayed };
  }

  async list(date?: string) {
    const day = date ?? businessDate(this.config.BUSINESS_TIMEZONE);
    const { rows } = await this.db.query<InvoiceRow>(`${SELECT_INVOICE} WHERE i.business_date = $1 ORDER BY i.number DESC`, [
      day,
    ]);
    return rows.map((row) => this.toSummary(row));
  }

  async get(id: string) {
    const row = await this.row(id);
    return { ...this.toSummary(row), items: await this.items(id) };
  }

  /** Returns the stored PDF, generating it first if it does not exist yet. */
  async pdf(id: string): Promise<{ number: string; body: Buffer }> {
    const key = await this.ensurePdf(id);
    const row = await this.row(id);
    return { number: this.fullNumber(row.number), body: await this.storage.get(key) };
  }

  private async row(id: string): Promise<InvoiceRow> {
    const { rows } = await this.db.query<InvoiceRow>(`${SELECT_INVOICE} WHERE i.id = $1`, [id]);
    if (rows.length === 0) {
      throw new AppError(404, 'INVOICE_NOT_FOUND', 'Invoice not found');
    }
    return rows[0];
  }

  private async ensurePdf(id: string): Promise<string> {
    const row = await this.row(id);
    if (row.pdf_key) {
      return row.pdf_key;
    }

    const { date: fecFac, time: horFac } = dianDateTime(row.issued_at, this.config.BUSINESS_TIMEZONE);
    const cufeInput = this.cufeInput(row.number, fecFac, horFac, row.subtotal, row.vat_total, row.total, {
      documentType: row.customer_document_type,
      document: row.customer_document,
    });
    const body = await renderInvoicePdf({
      config: this.config,
      fullNumber: this.fullNumber(row.number),
      issuedDate: fecFac,
      issuedTime: horFac,
      customer: {
        name: row.customer_name,
        documentType: row.customer_document_type,
        document: row.customer_document,
        email: row.customer_email,
        phone: row.customer_phone,
        address: row.customer_address,
      },
      paymentMethod: row.payment_method,
      paymentReference: row.payment_reference,
      sellerName: row.seller_name,
      subtotal: row.subtotal,
      vatTotal: row.vat_total,
      total: row.total,
      items: await this.items(id),
      cufe: row.cufe ?? computeCufe(cufeInput),
      cufeInput,
    });
    const key = `invoices/${row.business_date.slice(0, 4)}/${String(row.number).padStart(6, '0')}.pdf`;

    await this.storage.put(key, body, 'application/pdf');
    await this.db.query('UPDATE invoices SET pdf_key = $2 WHERE id = $1', [id, key]);
    return key;
  }

  private cufeInput(
    number: number,
    fecFac: string,
    horFac: string,
    subtotal: number,
    vatTotal: number,
    total: number,
    customer: { documentType: DocumentType | null; document: string | null },
  ): CufeInput {
    return {
      numFac: `${this.config.INVOICE_PREFIX}${number}`,
      fecFac,
      horFac,
      valFac: dianAmount(subtotal),
      valImp1: dianAmount(vatTotal),
      valImp2: '0.00',
      valImp3: '0.00',
      valTot: dianAmount(total),
      nitOfe: this.config.STORE_NIT.split('-')[0],
      numAdq: buyerIdForDian(customer.documentType, customer.document),
      clTec: this.config.DIAN_TECHNICAL_KEY,
      // Always the test environment: this system renders the graphic representation and never transmits to the DIAN.
      tipoAmbiente: '2',
    };
  }

  private fullNumber(number: number): string {
    return `${this.config.INVOICE_PREFIX}-${String(number).padStart(6, '0')}`;
  }

  private async items(invoiceId: string) {
    const { rows } = await this.db.query<ItemRow>(
      `SELECT ii.piece_id, p.sku, p.name, l.karat, p.gold_mg, ii.price, ii.cost, ii.vat_rate, ii.tax_base, ii.vat
       FROM invoice_items ii
       JOIN pieces p ON p.id = ii.piece_id
       JOIN gold_lots l ON l.id = p.lot_id
       WHERE ii.invoice_id = $1
       ORDER BY p.id`,
      [invoiceId],
    );
    return rows.map((row) => ({
      pieceId: row.piece_id,
      sku: row.sku,
      name: row.name,
      karat: row.karat,
      grams: mgToGrams(row.gold_mg),
      vatRate: row.vat_rate,
      taxBase: row.tax_base,
      vat: row.vat,
      price: row.price,
    }));
  }

  private toSummary(row: InvoiceRow) {
    return {
      id: row.id,
      number: row.number,
      fullNumber: this.fullNumber(row.number),
      businessDate: row.business_date,
      issuedAt: row.issued_at,
      customerName: row.customer_name,
      customerDocumentType: row.customer_document_type,
      customerDocument: row.customer_document,
      customerEmail: row.customer_email,
      customerPhone: row.customer_phone,
      customerAddress: row.customer_address,
      paymentMethod: row.payment_method,
      paymentReference: row.payment_reference,
      subtotal: row.subtotal,
      vatTotal: row.vat_total,
      total: row.total,
      cufe: row.cufe,
      seller: row.seller_name,
      createdAt: row.created_at,
    };
  }
}
