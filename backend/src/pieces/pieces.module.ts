import {
  Body,
  Controller,
  Get,
  Inject,
  Injectable,
  Module,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { randomUUID } from 'node:crypto';
import { PoolClient } from 'pg';
import { z } from 'zod';
import { AuditService } from '../audit/audit.module';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { AuthUser } from '../auth/auth.types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AppError } from '../common/app-error';
import { gramsToMg, mgToGrams } from '../common/business-day';
import { MAX_IMAGE_BYTES, requireImage } from '../common/image-upload';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { DatabaseService } from '../database/database.service';
import { FILE_STORAGE, FileStorage } from '../storage/storage.module';

// Multipart form fields arrive as strings, hence z.coerce; an empty optional field means "not given".
const optionalText = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((value) => (typeof value === 'string' && value.trim() === '' ? undefined : value), schema.optional());

const referenceSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9-]{1,23}$/, 'Use letters, digits and dashes, as in AN-DAM-172');
const sizeSchema = z.string().trim().min(1).max(24);
const categorySchema = z.enum(['ANILLO', 'CADENA', 'ARETES', 'PULSERA', 'DIJE', 'OTRO']);

const createPieceSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    reference: optionalText(referenceSchema),
    size: optionalText(sizeSchema),
    category: categorySchema,
    lotId: z.coerce.number().int().positive(),
    grams: z.coerce.number().positive().max(5_000),
    laborCost: z.coerce.number().int().min(0).max(100_000_000),
    price: z.coerce.number().int().positive().max(1_000_000_000),
  })
  .strict();

type CreatePieceInput = z.infer<typeof createPieceSchema>;

// Catalog fields only. Gold weight and lot are fixed once the gold is consumed; null clears an optional field.
const updatePieceSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    reference: referenceSchema.nullable(),
    size: sizeSchema.nullable(),
    category: categorySchema,
    laborCost: z.number().int().min(0).max(100_000_000),
    price: z.number().int().positive().max(1_000_000_000),
  })
  .partial()
  .strict()
  .refine((fields) => Object.keys(fields).length > 0, 'Send at least one field to change');

type UpdatePieceInput = z.infer<typeof updatePieceSchema>;

const UPDATE_COLUMNS: Record<keyof UpdatePieceInput, string> = {
  name: 'name',
  reference: 'reference',
  size: 'size',
  category: 'category',
  laborCost: 'labor_cost',
  price: 'price',
};


const listQuerySchema = z.object({ status: z.enum(['IN_STOCK', 'SOLD']).optional() });

interface PieceRow {
  id: number;
  sku: string;
  reference: string | null;
  size: string | null;
  name: string;
  category: string;
  lot_id: number;
  lot_code: string;
  karat: number;
  gold_mg: number;
  labor_cost: number;
  price: number;
  status: 'IN_STOCK' | 'SOLD';
  image_key: string | null;
}

const SELECT_PIECE = `
  SELECT p.id, p.sku, p.reference, p.size, p.name, p.category, p.lot_id, l.code AS lot_code, l.karat, p.gold_mg,
         p.labor_cost, p.price, p.status, p.image_key
  FROM pieces p JOIN gold_lots l ON l.id = p.lot_id
`;

@Injectable()
export class PiecesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
  ) {}

  private async toPiece(row: PieceRow) {
    return {
      id: row.id,
      sku: row.sku,
      reference: row.reference,
      size: row.size,
      name: row.name,
      category: row.category,
      lotId: row.lot_id,
      lotCode: row.lot_code,
      karat: row.karat,
      grams: mgToGrams(row.gold_mg),
      laborCost: row.labor_cost,
      price: row.price,
      status: row.status,
      imageUrl: row.image_key ? await this.storage.signedUrl(row.image_key) : null,
    };
  }

  async list(status?: 'IN_STOCK' | 'SOLD') {
    const { rows } = status
      ? await this.db.query<PieceRow>(`${SELECT_PIECE} WHERE p.status = $1 ORDER BY p.id DESC`, [status])
      : await this.db.query<PieceRow>(`${SELECT_PIECE} ORDER BY p.id DESC`);
    return Promise.all(rows.map((row) => this.toPiece(row)));
  }

  async get(id: number) {
    const { rows } = await this.db.query<PieceRow>(`${SELECT_PIECE} WHERE p.id = $1`, [id]);
    if (rows.length === 0) {
      throw new AppError(404, 'PIECE_NOT_FOUND', 'Piece not found');
    }
    return this.toPiece(rows[0]);
  }

  /** Creating a piece consumes gold from its lot; the lot can never go below zero. */
  async create(input: CreatePieceInput, image: Express.Multer.File | undefined, actor: AuthUser) {
    const goldMg = gramsToMg(input.grams);
    let imageKey: string | null = null;

    // Validate and upload before the transaction: no row stays locked during network I/O.
    // If the transaction then fails, the object is orphaned (cleaned up by a bucket lifecycle rule).
    if (image) {
      const type = requireImage(image);
      imageKey = `pieces/${randomUUID()}.${type.extension}`;
      await this.storage.put(imageKey, image.buffer, type.contentType);
    }

    const id = await this.db.transaction(async (client) => {
      const consumed = await client.query(
        `UPDATE gold_lots SET remaining_mg = remaining_mg - $1
         WHERE id = $2 AND remaining_mg >= $1
         RETURNING id`,
        [goldMg, input.lotId],
      );

      if (consumed.rows.length === 0) {
        const lot = await client.query<{ remaining_mg: number }>('SELECT remaining_mg FROM gold_lots WHERE id = $1', [
          input.lotId,
        ]);
        if (lot.rows.length === 0) {
          throw new AppError(404, 'LOT_NOT_FOUND', 'Gold lot not found');
        }
        throw new AppError(409, 'INSUFFICIENT_GOLD', 'Not enough gold left in this lot', {
          remainingGrams: mgToGrams(lot.rows[0].remaining_mg),
          requestedGrams: input.grams,
        });
      }

      // reference is the catalog code (several units can share it); sku is this physical piece's serial.
      const { rows } = await client.query<{ id: number }>(
          `INSERT INTO pieces (name, reference, size, category, lot_id, gold_mg, labor_cost, price, image_key, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           RETURNING id`,
          [
            input.name,
            input.reference ?? null,
            input.size ?? null,
            input.category,
            input.lotId,
            goldMg,
            input.laborCost,
            input.price,
            imageKey,
            actor.id,
          ],
        );

      await this.audit.record(client, {
        actorId: actor.id,
        action: 'PIECE_CREATED',
        entity: 'piece',
        entityId: rows[0].id,
        data: { ...input, hasImage: Boolean(imageKey) },
      });

      return rows[0].id;
    });

    return this.get(id);
  }

  /** Edits the catalog fields of a piece still in stock. A sold piece is part of an invoice and stays as it was. */
  async update(id: number, input: UpdatePieceInput, actor: AuthUser) {
    await this.db.transaction(async (client) => {
      const before = await this.lockInStock(client, id);
      const fields = Object.keys(input) as Array<keyof UpdatePieceInput>;
      const assignments = fields.map((field, index) => `${UPDATE_COLUMNS[field]} = $${index + 2}`);
      await client.query(`UPDATE pieces SET ${assignments.join(', ')} WHERE id = $1`, [id, ...fields.map((field) => input[field])]);

      await this.audit.record(client, {
        actorId: actor.id,
        action: 'PIECE_UPDATED',
        entity: 'piece',
        entityId: id,
        data: { before: Object.fromEntries(fields.map((field) => [field, before[UPDATE_COLUMNS[field]]])), after: input },
      });
    });
    return this.get(id);
  }

  /** Replaces the photo of a piece in stock. The previous object stays in the bucket for a lifecycle rule to expire. */
  async replacePhoto(id: number, image: Express.Multer.File | undefined, actor: AuthUser) {
    if (!image) {
      throw new AppError(400, 'IMAGE_REQUIRED', 'Attach the photo in the "image" field');
    }
    const type = requireImage(image);
    await this.get(id);
    const imageKey = `pieces/${randomUUID()}.${type.extension}`;
    await this.storage.put(imageKey, image.buffer, type.contentType);

    await this.db.transaction(async (client) => {
      const before = await this.lockInStock(client, id);
      await client.query('UPDATE pieces SET image_key = $2 WHERE id = $1', [id, imageKey]);
      await this.audit.record(client, {
        actorId: actor.id,
        action: 'PIECE_PHOTO_CHANGED',
        entity: 'piece',
        entityId: id,
        data: { before: before.image_key, after: imageKey },
      });
    });
    return this.get(id);
  }

  private async lockInStock(client: PoolClient, id: number) {
    const { rows } = await client.query<Record<string, unknown>>('SELECT * FROM pieces WHERE id = $1 FOR UPDATE', [id]);
    if (rows.length === 0) {
      throw new AppError(404, 'PIECE_NOT_FOUND', 'Piece not found');
    }
    if (rows[0].status !== 'IN_STOCK') {
      throw new AppError(409, 'PIECE_SOLD', 'A sold piece is part of an invoice and cannot be changed');
    }
    return rows[0];
  }
}

@Controller('pieces')
@UseGuards(JwtAuthGuard)
export class PiecesController {
  constructor(private readonly pieces: PiecesService) {}

  @Get()
  list(@Query(new ZodValidationPipe(listQuerySchema)) query: { status?: 'IN_STOCK' | 'SOLD' }) {
    return this.pieces.list(query.status);
  }

  @Get(':id')
  get(@Param('id', ParseIntPipe) id: number) {
    return this.pieces.get(id);
  }

  @Post()
  @Roles('ADMIN')
  @UseInterceptors(FileInterceptor('image', { limits: { fileSize: MAX_IMAGE_BYTES, files: 1 } }))
  create(
    @Body(new ZodValidationPipe(createPieceSchema)) body: CreatePieceInput,
    @UploadedFile() image: Express.Multer.File | undefined,
    @CurrentUser() user: AuthUser,
  ) {
    return this.pieces.create(body, image, user);
  }

  @Patch(':id')
  @Roles('ADMIN')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(updatePieceSchema)) body: UpdatePieceInput,
    @CurrentUser() user: AuthUser,
  ) {
    return this.pieces.update(id, body, user);
  }

  @Put(':id/photo')
  @Roles('ADMIN')
  @UseInterceptors(FileInterceptor('image', { limits: { fileSize: MAX_IMAGE_BYTES, files: 1 } }))
  replacePhoto(
    @Param('id', ParseIntPipe) id: number,
    @UploadedFile() image: Express.Multer.File | undefined,
    @CurrentUser() user: AuthUser,
  ) {
    return this.pieces.replacePhoto(id, image, user);
  }
}

@Module({
  controllers: [PiecesController],
  providers: [PiecesService],
})
export class PiecesModule {}
