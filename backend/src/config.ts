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
  // s3 for RustFS locally and S3 on AWS; postgres keeps files in the database (the free public demo has no
  // object store); memory for tests.
  STORAGE_DRIVER: z.enum(['s3', 'postgres', 'memory']).default('s3'),
  // Absolute base of this API as browsers reach it, used to build file links when STORAGE_DRIVER=postgres.
  PUBLIC_API_URL: z.url().optional(),
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
  // Public demo on free hosting: exact HTTPS origin, a request rate limit, and synthetic data that is restored
  // on every boot. The reset runs only when the connected database's name equals DEMO_DATABASE_CONFIRMATION.
  PUBLIC_DEMO: booleanFlag,
  DEMO_RESET_ON_BOOT: booleanFlag,
  DEMO_DATABASE_CONFIRMATION: z.string().regex(/^[a-z0-9_]{3,63}$/).optional(),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(240),
  DEMO_PASSWORD: z.string().min(8).default('yamesi-demo'),
  // Issuer data printed on every invoice (Estatuto Tributario art. 617). The defaults are fictitious on purpose:
  // this repository renders the graphic representation only and never transmits invoices to the DIAN.
  STORE_NAME: z.string().min(2).default('Joyería Yamesi'),
  STORE_LEGAL_NAME: z.string().min(2).default('Joyería Yamesi S.A.S.'),
  STORE_NIT: z.string().regex(/^\d{5,10}-\d$/, 'NIT with check digit, e.g. 900123456-7').default('000000000-0'),
  STORE_TAX_REGIME: z.string().min(2).default('Responsable de IVA'),
  STORE_ADDRESS: z.string().min(2).default('Medellín, Antioquia'),
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
}).superRefine((env, ctx) => {
  // .env.example publishes placeholder secrets. Anyone who knows the JWT one can sign an admin token.
  for (const key of ['JWT_SECRET', 'S3_SECRET_KEY'] as const) {
    if (env[key]?.startsWith('replace-with')) {
      ctx.addIssue({ code: 'custom', path: [key], message: 'replace the .env.example placeholder: openssl rand -hex 32, or delete .env and run make .env' });
    }
  }
  if (env.DEMO_RESET_ON_BOOT && !env.PUBLIC_DEMO) {
    ctx.addIssue({ code: 'custom', path: ['DEMO_RESET_ON_BOOT'], message: 'only allowed with PUBLIC_DEMO=true' });
  }
  if (env.PUBLIC_DEMO) {
    if (!env.DEMO_DATABASE_CONFIRMATION) {
      ctx.addIssue({ code: 'custom', path: ['DEMO_DATABASE_CONFIRMATION'], message: 'required with PUBLIC_DEMO=true' });
    }
    if (!/^https:\/\/[a-z0-9.-]+$/.test(env.CORS_ORIGIN)) {
      ctx.addIssue({ code: 'custom', path: ['CORS_ORIGIN'], message: 'must be one exact https origin with PUBLIC_DEMO=true' });
    }
    if (env.ASSISTANT_ENABLED) {
      ctx.addIssue({ code: 'custom', path: ['ASSISTANT_ENABLED'], message: 'the local AI assistant is not part of the public demo' });
    }
  }
  if (env.STORAGE_DRIVER === 'postgres' && !env.PUBLIC_API_URL) {
    ctx.addIssue({ code: 'custom', path: ['PUBLIC_API_URL'], message: 'required with STORAGE_DRIVER=postgres' });
  }
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
