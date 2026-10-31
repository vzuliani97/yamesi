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
  // Issuer data printed on every invoice (Estatuto Tributario art. 617). The defaults are fictitious on purpose:
  // this repository renders the graphic representation only and never transmits invoices to the DIAN.
  STORE_NAME: z.string().min(2).default('Joyería Yamesi'),
  STORE_LEGAL_NAME: z.string().min(2).default('Joyería Yamesi S.A.S. (datos de demostración)'),
  STORE_NIT: z.string().regex(/^\d{5,10}-\d$/, 'NIT with check digit, e.g. 900123456-7').default('000000000-0'),
  STORE_TAX_REGIME: z.string().min(2).default('Responsable de IVA'),
  STORE_ADDRESS: z.string().min(2).default('Dirección de demostración, Medellín, Antioquia'),
  STORE_PHONE: z.string().min(7).default('+57 604 000 0000'),
  STORE_EMAIL: z.email().default('facturacion@yamesi.local'),
  VAT_RATE_PERCENT: z.coerce.number().int().min(0).max(100).default(19),
  INVOICE_PREFIX: z.string().regex(/^[A-Z]{1,4}$/).default('FV'),
  DIAN_RESOLUTION_NUMBER: z.string().regex(/^\d{1,20}$/).default('00000000000000'),
  DIAN_RESOLUTION_DATE: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default('2026-01-01'),
  DIAN_RESOLUTION_VALID_UNTIL: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default('2028-01-01'),
  DIAN_RANGE_FROM: z.coerce.number().int().positive().default(1),
  DIAN_RANGE_TO: z.coerce.number().int().positive().default(100000),
  DIAN_TECHNICAL_KEY: z.string().min(8).default('clave-tecnica-de-demostracion'),
  GOLD_WARRANTY_TEXT: z
    .string()
    .min(20)
    .default(
      'Garantizamos de por vida que el oro de cada pieza corresponde al kilataje (ley) y al peso indicados en esta ' +
        'factura. Los defectos de fabricación tienen la garantía legal de la Ley 1480 de 2011 (Estatuto del Consumidor). ' +
        'Conserve esta factura: es el soporte para hacer efectiva la garantía.',
    ),
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
