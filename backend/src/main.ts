import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { assertUtcProcessZone } from './common/process-zone';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { ValidationPipe } from '@nestjs/common';
import helmet from 'helmet';

async function bootstrap(): Promise<void> {
  // First statement on purpose: before any cron or sync task can write a
  // locallyReadThroughAt watermark in the wrong parsing domain. A bad zone must
  // refuse the boot, not corrupt read state.
  assertUtcProcessZone();

  const app = await NestFactory.create(AppModule);

  app.use(helmet());

  const corsOrigin = process.env.CORS_ORIGIN;
  app.enableCors({
    origin: corsOrigin ? corsOrigin.split(',').map((o) => o.trim()) : false,
    credentials: true,
  });

  app.setGlobalPrefix('api/v1', { exclude: ['/health'] });
  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalInterceptors(new LoggingInterceptor());
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));

  const port = process.env.PORT || 3000;
  await app.listen(port);
}

bootstrap().catch((err: unknown) => {
  console.error('Failed to start application:', err);
  process.exit(1);
});
