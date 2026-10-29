import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { DATE_PATTERN, mgToGrams } from '../common/business-day';
import { DatabaseService } from '../database/database.service';
import { ToolDefinition } from './llm';

const MAX_RANGE_DAYS = 366;

const dateRange = z
  .object({ from: z.string().regex(DATE_PATTERN), to: z.string().regex(DATE_PATTERN) })
  .strict()
  .refine((r) => r.from <= r.to, { message: '"from" must not be after "to"' })
  .refine((r) => (Date.parse(r.to) - Date.parse(r.from)) / 86_400_000 <= MAX_RANGE_DAYS, {
    message: `The range cannot exceed ${MAX_RANGE_DAYS} days`,
  });

const rangeParameters = {
  type: 'object' as const,
  properties: {
    from: { type: 'string', description: 'Fecha inicial, inclusive, formato YYYY-MM-DD' },
    to: { type: 'string', description: 'Fecha final, inclusive, formato YYYY-MM-DD' },
  },
  required: ['from', 'to'],
};

interface Tool {
  definition: ToolDefinition;
  schema: z.ZodType;
  run: (args: never) => Promise<unknown>;
}

/**
 * The only things the model can do: fixed, read-only, aggregated queries.
 * It never writes SQL and never sees customer names or documents.
 */
@Injectable()
export class AssistantTools {
  private readonly tools: Record<string, Tool>;

  constructor(private readonly db: DatabaseService) {
    this.tools = {
      sales_summary: {
        definition: define('sales_summary', 'Ventas: número de facturas y total vendido entre dos fechas, separado por medio de pago (efectivo, tarjeta, transferencia).', rangeParameters),
        schema: dateRange,
        run: (args: z.infer<typeof dateRange>) => this.salesSummary(args.from, args.to),
      },
      sales_by_category: {
        definition: define('sales_by_category', 'Piezas vendidas y total vendido por categoría de joya (anillos, cadenas, etc.) entre dos fechas.', rangeParameters),
        schema: dateRange,
        run: (args: z.infer<typeof dateRange>) => this.salesByCategory(args.from, args.to),
      },
      margins: {
        definition: define('margins', 'Margen bruto: ventas, costo (oro + mano de obra) y ganancia bruta entre dos fechas.', rangeParameters),
        schema: dateRange,
        run: (args: z.infer<typeof dateRange>) => this.margins(args.from, args.to),
      },
      expenses_summary: {
        definition: define('expenses_summary', 'Gastos de caja menor entre dos fechas: total y por categoría.', rangeParameters),
        schema: dateRange,
        run: (args: z.infer<typeof dateRange>) => this.expensesSummary(args.from, args.to),
      },
      gold_inventory: {
        definition: define('gold_inventory', 'Inventario de oro actual por kilataje: gramos en lotes, en piezas disponibles y vendidos.', {
          type: 'object',
          properties: {},
          required: [],
        }),
        schema: z.object({}).passthrough(),
        run: () => this.goldInventory(),
      },
    };
  }

  definitions(): ToolDefinition[] {
    return Object.values(this.tools).map((tool) => tool.definition);
  }

  /** Validates the model's arguments; errors go back to the model as text instead of crashing the request. */
  async execute(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; result: unknown }> {
    const tool = this.tools[name];
    if (!tool) {
      return { ok: false, result: { error: `Unknown tool "${name}". Available: ${Object.keys(this.tools).join(', ')}` } };
    }

    const parsed = tool.schema.safeParse(args);
    if (!parsed.success) {
      return { ok: false, result: { error: parsed.error.issues.map((i) => i.message).join('; ') } };
    }

    return { ok: true, result: await tool.run(parsed.data as never) };
  }

  private async salesSummary(from: string, to: string) {
    const { rows } = await this.db.query<{ payment_method: string; invoices: string; revenue: string }>(
      `SELECT payment_method, COUNT(*) AS invoices, SUM(total) AS revenue
       FROM invoices WHERE business_date BETWEEN $1 AND $2 GROUP BY payment_method`,
      [from, to],
    );
    const byMethod = Object.fromEntries(rows.map((r) => [r.payment_method, Number(r.revenue)]));
    return {
      from,
      to,
      invoices: rows.reduce((n, r) => n + Number(r.invoices), 0),
      revenueCop: rows.reduce((n, r) => n + Number(r.revenue), 0),
      revenueByPaymentMethodCop: byMethod,
    };
  }

  private async salesByCategory(from: string, to: string) {
    const { rows } = await this.db.query<{ category: string; pieces: string; revenue: string }>(
      `SELECT p.category, COUNT(*) AS pieces, SUM(ii.price) AS revenue
       FROM invoice_items ii
       JOIN invoices i ON i.id = ii.invoice_id
       JOIN pieces p ON p.id = ii.piece_id
       WHERE i.business_date BETWEEN $1 AND $2
       GROUP BY p.category ORDER BY SUM(ii.price) DESC`,
      [from, to],
    );
    return { from, to, categories: rows.map((r) => ({ category: r.category, pieces: Number(r.pieces), revenueCop: Number(r.revenue) })) };
  }

  private async margins(from: string, to: string) {
    const { rows } = await this.db.query<{ revenue: string; cost: string }>(
      `SELECT COALESCE(SUM(ii.price), 0) AS revenue, COALESCE(SUM(ii.cost), 0) AS cost
       FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
       WHERE i.business_date BETWEEN $1 AND $2`,
      [from, to],
    );
    const revenue = Number(rows[0].revenue);
    const cost = Number(rows[0].cost);
    return {
      from,
      to,
      revenueCop: revenue,
      costCop: cost,
      grossMarginCop: revenue - cost,
      marginPercent: revenue > 0 ? Math.round(((revenue - cost) / revenue) * 1000) / 10 : 0,
    };
  }

  private async expensesSummary(from: string, to: string) {
    const { rows } = await this.db.query<{ category: string; total: string }>(
      `SELECT category, SUM(amount) AS total FROM expenses
       WHERE business_date BETWEEN $1 AND $2 GROUP BY category ORDER BY SUM(amount) DESC`,
      [from, to],
    );
    return {
      from,
      to,
      totalCop: rows.reduce((n, r) => n + Number(r.total), 0),
      byCategoryCop: Object.fromEntries(rows.map((r) => [r.category, Number(r.total)])),
    };
  }

  private async goldInventory() {
    const { rows } = await this.db.query<{ karat: number; lots: string; stock: string; sold: string }>(
      `SELECT l.karat, SUM(l.remaining_mg) AS lots,
              COALESCE(SUM(p.stock), 0) AS stock, COALESCE(SUM(p.sold), 0) AS sold
       FROM gold_lots l
       LEFT JOIN (
         SELECT lot_id, SUM(gold_mg) FILTER (WHERE status = 'IN_STOCK') AS stock,
                        SUM(gold_mg) FILTER (WHERE status = 'SOLD') AS sold
         FROM pieces GROUP BY lot_id
       ) p ON p.lot_id = l.id
       GROUP BY l.karat ORDER BY l.karat`,
    );
    return rows.map((r) => ({
      karat: r.karat,
      gramsInLots: mgToGrams(Number(r.lots)),
      gramsInStockPieces: mgToGrams(Number(r.stock)),
      gramsSold: mgToGrams(Number(r.sold)),
    }));
  }
}

function define(name: string, description: string, parameters: ToolDefinition['function']['parameters']): ToolDefinition {
  return { type: 'function', function: { name, description, parameters } };
}
