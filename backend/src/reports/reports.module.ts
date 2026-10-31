import { Controller, Get, Injectable, Module, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { Roles } from '../auth/auth.decorators';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AppError } from '../common/app-error';
import { DATE_PATTERN, mgToGrams } from '../common/business-day';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { DatabaseService } from '../database/database.service';

const rangeSchema = z
  .object({ from: z.string().regex(DATE_PATTERN), to: z.string().regex(DATE_PATTERN) })
  .refine((range) => range.from <= range.to, { message: '"from" must not be after "to"' });

@Injectable()
export class ReportsService {
  constructor(private readonly db: DatabaseService) {}

  /** Gold by karat: still raw in lots, made into pieces in stock, and already sold. */
  async goldInventory() {
    const { rows } = await this.db.query<{
      karat: number;
      in_lots_mg: string;
      in_stock_mg: string;
      sold_mg: string;
      in_lots_value: string;
    }>(
      `SELECT l.karat,
              SUM(l.remaining_mg) AS in_lots_mg,
              SUM(l.remaining_mg::numeric * l.cost_per_gram / 1000)::bigint AS in_lots_value,
              COALESCE(SUM(p.in_stock_mg), 0) AS in_stock_mg,
              COALESCE(SUM(p.sold_mg), 0) AS sold_mg
       FROM gold_lots l
       LEFT JOIN (
         SELECT lot_id,
                SUM(gold_mg) FILTER (WHERE status = 'IN_STOCK') AS in_stock_mg,
                SUM(gold_mg) FILTER (WHERE status = 'SOLD') AS sold_mg
         FROM pieces GROUP BY lot_id
       ) p ON p.lot_id = l.id
       GROUP BY l.karat
       ORDER BY l.karat`,
    );

    return rows.map((row) => ({
      karat: row.karat,
      gramsInLots: mgToGrams(Number(row.in_lots_mg)),
      gramsInStock: mgToGrams(Number(row.in_stock_mg)),
      gramsSold: mgToGrams(Number(row.sold_mg)),
      lotsValueAtCost: Number(row.in_lots_value),
    }));
  }

  /** Gross margin from the cost frozen on each invoice line at the time of sale. Revenue excludes VAT: it belongs to the DIAN. */
  async margins(from: string, to: string) {
    const { rows } = await this.db.query<{ invoices: string; revenue: string; cost: string }>(
      `SELECT COUNT(DISTINCT i.id) AS invoices, COALESCE(SUM(ii.tax_base), 0) AS revenue, COALESCE(SUM(ii.cost), 0) AS cost
       FROM invoices i JOIN invoice_items ii ON ii.invoice_id = i.id
       WHERE i.business_date BETWEEN $1 AND $2`,
      [from, to],
    );
    const revenue = Number(rows[0].revenue);
    const cost = Number(rows[0].cost);

    return {
      from,
      to,
      invoices: Number(rows[0].invoices),
      revenue,
      cost,
      grossMargin: revenue - cost,
      marginPercent: revenue > 0 ? Math.round(((revenue - cost) / revenue) * 1000) / 10 : 0,
    };
  }
}

@Controller('reports')
@UseGuards(JwtAuthGuard)
@Roles('ADMIN')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('gold-inventory')
  goldInventory() {
    return this.reports.goldInventory();
  }

  @Get('margins')
  margins(@Query() query: unknown) {
    const parsed = rangeSchema.safeParse(query);
    if (!parsed.success) {
      throw new AppError(400, 'INVALID_INPUT', 'Query parameters "from" and "to" must be dates (YYYY-MM-DD)');
    }
    return this.reports.margins(parsed.data.from, parsed.data.to);
  }
}

@Module({
  controllers: [ReportsController],
  providers: [ReportsService],
})
export class ReportsModule {}
