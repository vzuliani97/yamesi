import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  Controller,
  Get,
  Global,
  Inject,
  Injectable,
  Logger,
  Module,
  OnModuleInit,
  Param,
  Query,
  Res,
  StreamableFile,
} from '@nestjs/common';
import { Response } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppError } from '../common/app-error';
import { APP_CONFIG, AppConfig } from '../config';
import { DatabaseService } from '../database/database.service';

export const FILE_STORAGE = Symbol('FILE_STORAGE');

/** Port for binary files (piece photos, receipts, invoice PDFs). */
export interface FileStorage {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  /** Short-lived URL the browser can use directly, e.g. in an <img> tag. */
  signedUrl(key: string, expiresInSeconds?: number): Promise<string>;
}

@Injectable()
export class S3FileStorage implements FileStorage, OnModuleInit {
  private readonly logger = new Logger(S3FileStorage.name);
  private readonly client: S3Client;
  private readonly publicClient: S3Client;

  constructor(private readonly config: AppConfig) {
    const credentials =
      config.S3_ACCESS_KEY && config.S3_SECRET_KEY
        ? { accessKeyId: config.S3_ACCESS_KEY, secretAccessKey: config.S3_SECRET_KEY }
        : undefined;
    const base = { region: config.S3_REGION, credentials, forcePathStyle: Boolean(config.S3_ENDPOINT) };

    this.client = new S3Client({ ...base, endpoint: config.S3_ENDPOINT });
    // Presigned URLs embed the host, so they must use the address the browser can reach.
    this.publicClient = new S3Client({ ...base, endpoint: config.S3_PUBLIC_ENDPOINT ?? config.S3_ENDPOINT });
  }

  async onModuleInit(): Promise<void> {
    const Bucket = this.config.S3_BUCKET;

    try {
      await this.client.send(new HeadBucketCommand({ Bucket }));
    } catch {
      await this.client.send(new CreateBucketCommand({ Bucket }));
      this.logger.log(`Created bucket ${Bucket}`);
    }
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.config.S3_BUCKET, Key: key, Body: body, ContentType: contentType }),
    );
  }

  async get(key: string): Promise<Buffer> {
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.config.S3_BUCKET, Key: key }));
    return Buffer.from(await result.Body!.transformToByteArray());
  }

  signedUrl(key: string, expiresInSeconds = 300): Promise<string> {
    return getSignedUrl(this.publicClient, new GetObjectCommand({ Bucket: this.config.S3_BUCKET, Key: key }), {
      expiresIn: expiresInSeconds,
    });
  }
}

/** Used by the e2e tests and for running without an object store. */
@Injectable()
export class InMemoryFileStorage implements FileStorage {
  readonly objects = new Map<string, { body: Buffer; contentType: string }>();

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    this.objects.set(key, { body, contentType });
  }

  async get(key: string): Promise<Buffer> {
    const object = this.objects.get(key);
    if (!object) {
      throw new Error(`Object not found: ${key}`);
    }
    return object.body;
  }

  async signedUrl(key: string): Promise<string> {
    return `memory://${key}`;
  }
}

/**
 * Files kept in PostgreSQL, for the free public demo, which has no object store. Links work like S3 presigned
 * URLs: the API signs key and expiry with HMAC-SHA256, and FilesController serves the file only while the
 * signature is valid and unexpired.
 */
@Injectable()
export class PostgresFileStorage implements FileStorage {
  private readonly signingKey: Buffer;

  constructor(
    private readonly db: DatabaseService,
    private readonly config: AppConfig,
  ) {
    // Derived from the JWT secret, so it needs no extra setting and a file link can never pass as a token.
    this.signingKey = createHmac('sha256', config.JWT_SECRET).update('yamesi:file-links').digest();
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.db.query(
      `INSERT INTO stored_files (key, content_type, body) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET content_type = EXCLUDED.content_type, body = EXCLUDED.body`,
      [key, contentType, body],
    );
  }

  async get(key: string): Promise<Buffer> {
    return (await this.read(key)).body;
  }

  async read(key: string): Promise<{ body: Buffer; contentType: string }> {
    const { rows } = await this.db.query<{ body: Buffer; content_type: string }>(
      'SELECT body, content_type FROM stored_files WHERE key = $1',
      [key],
    );
    if (rows.length === 0) {
      throw new AppError(404, 'FILE_NOT_FOUND', 'File not found');
    }
    return { body: rows[0].body, contentType: rows[0].content_type };
  }

  async signedUrl(key: string, expiresInSeconds = 300): Promise<string> {
    const expires = Math.floor(Date.now() / 1000) + expiresInSeconds;
    const query = `expires=${expires}&signature=${this.sign(key, expires)}`;
    return `${this.config.PUBLIC_API_URL}/api/files/${encodeURIComponent(key)}?${query}`;
  }

  isValid(key: string, expires: string, signature: string, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
    if (!/^\d{10}$/.test(expires) || Number(expires) < nowSeconds || !/^[0-9a-f]{64}$/.test(signature)) {
      return false;
    }
    return timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(this.sign(key, Number(expires)), 'hex'));
  }

  private sign(key: string, expires: number): string {
    return createHmac('sha256', this.signingKey).update(`${key}\n${expires}`).digest('hex');
  }
}

/** Serves PostgreSQL-stored files to whoever holds a valid signed link. Answers 404 with any other driver. */
@Controller('files')
export class FilesController {
  constructor(@Inject(FILE_STORAGE) private readonly storage: FileStorage) {}

  @Get(':key')
  async download(
    @Param('key') key: string,
    @Query('expires') expires: string,
    @Query('signature') signature: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!(this.storage instanceof PostgresFileStorage)) {
      throw new AppError(404, 'NOT_FOUND', 'Not found');
    }
    if (!this.storage.isValid(key, String(expires ?? ''), String(signature ?? ''))) {
      throw new AppError(403, 'INVALID_FILE_LINK', 'This file link is invalid or has expired');
    }
    const file = await this.storage.read(key);
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Cache-Control', 'private, max-age=300');
    // The demo frontend lives on another origin (Netlify) and shows these files in <img> tags.
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    return new StreamableFile(file.body);
  }
}

@Global()
@Module({
  controllers: [FilesController],
  providers: [
    {
      provide: FILE_STORAGE,
      inject: [APP_CONFIG, DatabaseService],
      useFactory: (config: AppConfig, db: DatabaseService): FileStorage => {
        if (config.STORAGE_DRIVER === 'memory') return new InMemoryFileStorage();
        if (config.STORAGE_DRIVER === 'postgres') return new PostgresFileStorage(db, config);
        return new S3FileStorage(config);
      },
    },
  ],
  exports: [FILE_STORAGE],
})
export class StorageModule {}
