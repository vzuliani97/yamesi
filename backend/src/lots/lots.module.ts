import { Body, Controller, Get, Injectable, Module, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../audit/audit.module';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { AuthUser } from '../auth/auth.types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { DATE_PATTERN, gramsToMg, mgToGrams } from '../common/business-day';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { DatabaseService } from '../database/database.service';

const createLotSchema = z
  .object({
    karat: z.union([z.literal(14), z.literal(18), z.literal(24)]),
    supplier: z.string().trim().min(2).max(120),
    grams: z
      .number()
      .positive()
      .max(100_000)
      .refine((g) => Math.abs(g * 1000 - Math.round(g * 1000)) < 1e-6, {
        message: 'At most 3 decimals (milligram precision)',
      }),
    costPerGram: z.number().int().positive().max(10_000_000),
    purchasedOn: z.string().regex(DATE_PATTERN),
  })
  .strict();

type CreateLotInput = z.infer<typeof createLotSchema>;

interface LotRow {
  id: number;
  code: string;
  karat: number;
  supplier: string;
  total_mg: number;
  remaining_mg: number;
  cost_per_gram: number;
  purchased_on: string;
}

const toLot = (row: LotRow) => ({
  id: row.id,
  code: row.code,
  karat: row.karat,
  supplier: row.supplier,
  totalGrams: mgToGrams(row.total_mg),
  remainingGrams: mgToGrams(row.remaining_mg),
  costPerGram: row.cost_per_gram,
  purchasedOn: row.purchased_on,
});

const SELECT_LOT = `SELECT id, code, karat, supplier, total_mg, remaining_mg, cost_per_gram,
                           to_char(purchased_on, 'YYYY-MM-DD') AS purchased_on
                    FROM gold_lots`;

@Injectable()
export class LotsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async list() {
    const { rows } = await this.db.query<LotRow>(`${SELECT_LOT} ORDER BY id DESC`);
    return rows.map(toLot);
  }

  create(input: CreateLotInput, actor: AuthUser) {
    const mg = gramsToMg(input.grams);

    return this.db.transaction(async (client) => {
      const { rows } = await client.query<{ id: number }>(
        `INSERT INTO gold_lots (karat, supplier, total_mg, remaining_mg, cost_per_gram, purchased_on, created_by)
         VALUES ($1, $2, $3, $3, $4, $5, $6)
         RETURNING id`,
        [input.karat, input.supplier, mg, input.costPerGram, input.purchasedOn, actor.id],
      );
      const created = await client.query<LotRow>(`${SELECT_LOT} WHERE id = $1`, [rows[0].id]);
      const lot = toLot(created.rows[0]);

      await this.audit.record(client, { actorId: actor.id, action: 'LOT_CREATED', entity: 'gold_lot', entityId: lot.id, data: lot });
      return lot;
    });
  }
}

@Controller('lots')
@UseGuards(JwtAuthGuard)
export class LotsController {
  constructor(private readonly lots: LotsService) {}

  @Get()
  list() {
    return this.lots.list();
  }

  @Post()
  @Roles('ADMIN')
  create(@Body(new ZodValidationPipe(createLotSchema)) body: CreateLotInput, @CurrentUser() user: AuthUser) {
    return this.lots.create(body, user);
  }
}

@Module({
  controllers: [LotsController],
  providers: [LotsService],
})
export class LotsModule {}
