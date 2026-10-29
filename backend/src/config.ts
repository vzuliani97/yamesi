import { z } from 'zod';

export const APP_CONFIG = Symbol('APP_CONFIG');

const booleanFlag = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32, 'must be at least 32 characters'),
  JWT_EXPIRES_IN_SECONDS: z.coerce.number().int().positive().default(28800), // one work shift
  CORS_ORIGIN: z.string().default('http://localhost:8083'),
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  // The store's "day" for invoices and cash closing follows local time, not UTC.
  BUSINESS_TIMEZONE: z.string().default('America/Bogota'),
  STORAGE_DRIVER: z.enum(['s3', 'memory']).default('s3'),
  // Leave S3_ENDPOINT empty on real AWS. Set it for S3-compatible servers (RustFS, MinIO).
  S3_ENDPOINT: z.url().optional(),
  // Host the browser uses for presigned URLs, when it differs from the one the API uses.
  S3_PUBLIC_ENDPOINT: z.url().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().min(3).default('yamesi'),
  // Omit on AWS to use the IAM role of the pod or instance.
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),
  // Optional AI assistant backed by a local model (Ollama). Off unless explicitly enabled.
  ASSISTANT_ENABLED: booleanFlag,
  OLLAMA_URL: z.url().default('http://localhost:11434'),
  OLLAMA_MODEL: z.string().min(1).default('qwen2.5:3b'),
  ASSISTANT_TIMEOUT_MS: z.coerce.number().int().positive().default(120000),
  SEED_DEMO_DATA: booleanFlag,
  DEMO_PASSWORD: z.string().min(8).default('yamesi-demo'),
});

export type AppConfig = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(env);

  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new Error(`Invalid configuration: ${problems}`);
  }

  return parsed.data;
}
