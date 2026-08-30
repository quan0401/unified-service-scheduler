import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { PrismaModule } from './prisma/prisma.module';
import { ObservabilityModule } from './observability/observability.module';
import { CatalogModule } from './modules/catalog/catalog.module';
import { AvailabilityModule } from './modules/availability/availability.module';
import { AppointmentsModule } from './modules/appointments/appointments.module';
import { BackgroundJobsModule } from './modules/background-jobs/background-jobs.module';
import { RequestContextMiddleware } from './common/request-context.middleware';
import { loggingConfig } from './observability/logging.config';
import { readPositiveInt } from './common/env';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    LoggerModule.forRoot(loggingConfig()),
    ScheduleModule.forRoot(),

    // Rate limiting is per-IP because this service has no authentication by
    // design (the brief does not ask for it). With auth it would key on the
    // customer instead, which is strictly better -- one abusive client behind a
    // shared NAT currently consumes the budget for everyone behind it.
    //
    // Limits are environment-driven rather than hardcoded. Load tests drive
    // hundreds of requests from a single address, which is indistinguishable
    // from abuse at production thresholds; raising the ceiling there keeps the
    // guard wired (so a misconfiguration still surfaces) without having it
    // measure the wrong thing.
    ThrottlerModule.forRoot([
      {
        name: 'burst',
        ttl: 1_000,
        limit: readPositiveInt('THROTTLE_BURST_LIMIT', 20),
      },
      {
        name: 'sustained',
        ttl: 60_000,
        limit: readPositiveInt('THROTTLE_SUSTAINED_LIMIT', 300),
      },
    ]),

    PrismaModule,
    ObservabilityModule,
    CatalogModule,
    AvailabilityModule,
    AppointmentsModule,
    BackgroundJobsModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // First and on everything: the correlation ID must exist before any
    // handler, filter, or log line runs.
    consumer.apply(RequestContextMiddleware).forRoutes('*path');
  }
}
