import { RequestMethod } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { AppConfig } from './config';

/** HTTP setup shared by main.ts and the e2e tests. */
export function configureApp(app: NestExpressApplication, config: AppConfig): void {
  app.set('trust proxy', config.TRUST_PROXY);
  app.use(helmet());
  app.enableCors({ origin: config.CORS_ORIGIN });
  app.useBodyParser('json', { limit: '20kb' });
  app.setGlobalPrefix('api', { exclude: [{ path: 'health', method: RequestMethod.GET }] });
  app.useGlobalFilters(new AllExceptionsFilter());
}
