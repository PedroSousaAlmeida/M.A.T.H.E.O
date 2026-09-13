import { z } from 'zod';

const schema = z
  .object({
    PORT: z.coerce.number().int().positive().default(3000),
    DATABASE_URL: z.url(),
    LOGTO_ENDPOINT: z.url(),
    LOGTO_JWKS_URL: z.url().optional(),
    LOGTO_API_RESOURCE: z.string().min(1),
    CERT_ENCRYPTION_KEY: z
      .string()
      .regex(/^[0-9a-fA-F]{64}$/, 'CERT_ENCRYPTION_KEY must be 32 bytes encoded as 64 hex chars'),
    NFSE_ENV: z.enum(['fake', 'producao-restrita', 'producao']).default('fake'),
    NFSE_SEFIN_URL: z.url().optional(),
    NFSE_ADN_URL: z.url().optional(),
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    APP_STAGE: z.enum(['alpha', 'beta', 'rc', 'stable']).optional(),
    GIT_COMMIT: z.string().min(1).optional(),
    MEI_ANNUAL_LIMIT: z.coerce.number().positive().default(81000),
    CORS_ORIGINS: z
      .string()
      .default('http://localhost:5173')
      .transform((v) => v.split(',').map((o) => o.trim()).filter(Boolean)),
    LOG_LEVEL: z.enum(['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    LOG_PRETTY: z
      .string()
      .optional()
      .transform((v) => (v === undefined ? undefined : v === 'true' || v === '1')),
  })
  .superRefine((env, ctx) => {
    if (env.NFSE_ENV !== 'fake') {
      for (const key of ['NFSE_SEFIN_URL', 'NFSE_ADN_URL'] as const) {
        if (!env[key]) {
          ctx.addIssue({ code: 'custom', path: [key], message: `${key} is required when NFSE_ENV=${env.NFSE_ENV}` });
        }
      }
    }
  });

export type Env = z.infer<typeof schema>;

export function validateEnv(raw: Record<string, unknown>): Env {
  const result = schema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment:\n${lines.join('\n')}`);
  }
  return result.data;
}
