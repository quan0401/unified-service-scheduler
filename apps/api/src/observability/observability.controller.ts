import { Controller, Get, Header, ServiceUnavailableException } from '@nestjs/common';
import { RawResponse } from '../common/raw-response.decorator';
import { MetricsService } from './metrics.service';
import { PrismaService } from '../prisma/prisma.service';

@Controller()
export class ObservabilityController {
  constructor(
    private readonly metrics: MetricsService,
    private readonly prisma: PrismaService,
  ) {}

  /** Liveness: the process is up. Deliberately touches no dependency. */
  @Get('health')
  health() {
    return { status: 'ok', uptimeSeconds: Math.floor(process.uptime()) };
  }

  /**
   * Readiness: the process can serve traffic.
   *
   * Separate from liveness so a database blip removes the instance from the
   * load balancer without triggering a restart loop that would make it worse.
   */
  @Get('health/ready')
  async ready() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'ready', database: 'up' };
    } catch {
      throw new ServiceUnavailableException('Database is not reachable.');
    }
  }

  @Get('metrics')
  @RawResponse()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  scrape(): Promise<string> {
    return this.metrics.scrape();
  }
}
