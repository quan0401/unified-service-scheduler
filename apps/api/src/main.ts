// Tracing must be initialised before any instrumented module is imported,
// otherwise auto-instrumentation silently patches nothing.
import { startTracing } from './observability/tracing';
startTracing();

import { NestFactory, Reflector } from '@nestjs/core';
import { ZodValidationPipe } from 'nestjs-zod';
import { Logger as PinoLogger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { DomainExceptionFilter } from './common/domain-exception.filter';
import { ResponseEnvelopeInterceptor } from './common/response.interceptor';
import { writeOpenApiDocument } from './openapi';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(PinoLogger));

  app.enableCors({ origin: process.env.CORS_ORIGIN ?? '*' });

  // Zod schemas are the single source of truth for request shape; the pipe
  // rejects anything that does not match before a handler runs.
  app.useGlobalPipes(new ZodValidationPipe());
  app.useGlobalInterceptors(new ResponseEnvelopeInterceptor(app.get(Reflector)));
  app.useGlobalFilters(new DomainExceptionFilter());

  writeOpenApiDocument(app);

  // Graceful shutdown: in-flight bookings finish before the process exits, so a
  // deploy cannot leave a half-written appointment.
  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  app.get(PinoLogger).log(`Scheduler API listening on http://localhost:${port}`);
}

void bootstrap();
