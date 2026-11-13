import { RequestMethod } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { rateLimit } from './common/rate-limit';
import { AppConfig } from './config';
import { SecurityEvents } from './security/security-events';

/** HTTP setup shared by main.ts and the e2e tests. */
export function configureApp(app: NestExpressApplication, config: AppConfig): void {
  app.set('trust proxy', config.TRUST_PROXY);
  app.use(helmet());
  if (config.PUBLIC_DEMO) {
    app.use(rateLimit(config.RATE_LIMIT_PER_MINUTE));
  }
  app.enableCors({ origin: config.CORS_ORIGIN });
  app.useBodyParser('json', { limit: '20kb' });
  app.setGlobalPrefix('api', { exclude: [{ path: 'health', method: RequestMethod.GET }] });
  app.useGlobalFilters(new AllExceptionsFilter(app.get(SecurityEvents)));
}
