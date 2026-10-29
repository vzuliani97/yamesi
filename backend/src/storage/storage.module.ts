import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Global, Injectable, Logger, Module, OnModuleInit } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config';

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

@Global()
@Module({
  providers: [
    {
      provide: FILE_STORAGE,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): FileStorage =>
        config.STORAGE_DRIVER === 'memory' ? new InMemoryFileStorage() : new S3FileStorage(config),
    },
  ],
  exports: [FILE_STORAGE],
})
export class StorageModule {}
