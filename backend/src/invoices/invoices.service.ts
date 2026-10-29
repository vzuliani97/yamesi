import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { AuditService } from '../audit/audit.module';
import { AuthUser } from '../auth/auth.types';
import { AppError } from '../common/app-error';
import { assertDayOpen, businessDate, lockDayShared, mgToGrams } from '../common/business-day';
import { APP_CONFIG, AppConfig } from '../config';
import { DatabaseService } from '../database/database.service';
import { FILE_STORAGE, FileStorage } from '../storage/storage.module';
import { renderInvoicePdf } from './invoice-pdf';

export type PaymentMethod = 'CASH' | 'CARD' | 'TRANSFER';

export interface CreateInvoiceInput {
  customerName: string;
  customerDocument?: string;
  paymentMethod: PaymentMethod;
  pieceIds: number[];
}

interface InvoiceRow {
  id: string;
  number: number;
  business_date: string;
  customer_name: string;
  customer_document: string | null;
  payment_method: PaymentMethod;
  total: number;
  pdf_key: string | null;
  request_hash: string;
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
}

const SELECT_INVOICE = `
  SELECT i.id, i.number, to_char(i.business_date, 'YYYY-MM-DD') AS business_date, i.customer_name,
         i.customer_document, i.payment_method, i.total, i.pdf_key, i.request_hash, i.created_at,
         u.name AS seller_name
  FROM invoices i JOIN users u ON u.id = i.seller_id
`;

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
    const requestHash = createHash('sha256')
      .update(JSON.stringify([input.customerName, input.customerDocument ?? null, input.paymentMethod, pieceIds]))
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
      const sold = await client.query<ItemRow>(
        `WITH sold AS (
           UPDATE pieces SET status = 'SOLD'
           WHERE id = ANY($1::int[]) AND status = 'IN_STOCK'
           RETURNING id, sku, name, lot_id, gold_mg, labor_cost, price
         )
         SELECT s.id AS piece_id, s.sku, s.name, l.karat, s.gold_mg, s.price,
                (ROUND(s.gold_mg::numeric * l.cost_per_gram / 1000) + s.labor_cost)::int AS cost
         FROM sold s JOIN gold_lots l ON l.id = s.lot_id`,
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
      const total = sold.rows.reduce((sum, row) => sum + row.price, 0);

      const invoice = await client.query<{ id: string }>(
        `INSERT INTO invoices (number, business_date, customer_name, customer_document, payment_method, total,
                               idempotency_key, request_hash, seller_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id`,
        [
          counter.rows[0].last_number,
          date,
          input.customerName,
          input.customerDocument ?? null,
          input.paymentMethod,
          total,
          idempotencyKey,
          requestHash,
          seller.id,
        ],
      );
      const invoiceId = invoice.rows[0].id;

      for (const item of sold.rows) {
        await client.query('INSERT INTO invoice_items (invoice_id, piece_id, price, cost) VALUES ($1, $2, $3, $4)', [
          invoiceId,
          item.piece_id,
          item.price,
          item.cost,
        ]);
      }

      await this.audit.record(client, {
        actorId: seller.id,
        action: 'INVOICE_CREATED',
        entity: 'invoice',
        entityId: invoiceId,
        data: { number: counter.rows[0].last_number, total, pieceIds, paymentMethod: input.paymentMethod },
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
    const { rows } = await this.db.query<InvoiceRow>(`${SELECT_INVOICE} WHERE i.id = $1`, [id]);
    if (rows.length === 0) {
      throw new AppError(404, 'INVOICE_NOT_FOUND', 'Invoice not found');
    }
    return { ...this.toSummary(rows[0]), items: await this.items(id) };
  }

  /** Returns the stored PDF, generating it first if it does not exist yet. */
  async pdf(id: string): Promise<{ number: number; body: Buffer }> {
    const key = await this.ensurePdf(id);
    const invoice = await this.get(id);
    return { number: invoice.number, body: await this.storage.get(key) };
  }

  private async ensurePdf(id: string): Promise<string> {
    const { rows } = await this.db.query<InvoiceRow>(`${SELECT_INVOICE} WHERE i.id = $1`, [id]);
    if (rows.length === 0) {
      throw new AppError(404, 'INVOICE_NOT_FOUND', 'Invoice not found');
    }
    const row = rows[0];
    if (row.pdf_key) {
      return row.pdf_key;
    }

    const body = await renderInvoicePdf({
      number: row.number,
      businessDate: row.business_date,
      customerName: row.customer_name,
      customerDocument: row.customer_document,
      paymentMethod: row.payment_method,
      sellerName: row.seller_name,
      total: row.total,
      items: await this.items(id),
    });
    const key = `invoices/${row.business_date.slice(0, 4)}/${String(row.number).padStart(6, '0')}.pdf`;

    await this.storage.put(key, body, 'application/pdf');
    await this.db.query('UPDATE invoices SET pdf_key = $2 WHERE id = $1', [id, key]);
    return key;
  }

  private async items(invoiceId: string) {
    const { rows } = await this.db.query<ItemRow>(
      `SELECT ii.piece_id, p.sku, p.name, l.karat, p.gold_mg, ii.price, ii.cost
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
      price: row.price,
    }));
  }

  private toSummary(row: InvoiceRow) {
    return {
      id: row.id,
      number: row.number,
      businessDate: row.business_date,
      customerName: row.customer_name,
      customerDocument: row.customer_document,
      paymentMethod: row.payment_method,
      total: row.total,
      seller: row.seller_name,
      createdAt: row.created_at,
    };
  }
}
