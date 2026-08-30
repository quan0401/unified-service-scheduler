import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { NotFoundError } from '../../common/domain-errors';

@Injectable()
export class CatalogService {
  constructor(private readonly prisma: PrismaService) {}

  listDealerships() {
    return this.prisma.dealership.findMany({
      select: {
        id: true,
        name: true,
        timezone: true,
        openingHours: {
          select: { dayOfWeek: true, openMinute: true, closeMinute: true },
          orderBy: { dayOfWeek: 'asc' },
        },
      },
      orderBy: { name: 'asc' },
    });
  }

  listServiceTypes() {
    return this.prisma.serviceType.findMany({
      select: { id: true, name: true, durationMinutes: true },
      orderBy: { name: 'asc' },
    });
  }

  async listVehicles(customerId: string) {
    // Verified explicitly so an unknown customer is a 404 rather than an empty
    // list, which would otherwise be indistinguishable from "owns no vehicles".
    const customer = await this.prisma.customer.findUnique({ where: { id: customerId } });
    if (!customer) {
      throw new NotFoundError('CUSTOMER_NOT_FOUND', `No customer with id ${customerId}.`);
    }

    return this.prisma.vehicle.findMany({
      where: { customerId },
      select: { id: true, vin: true, make: true, model: true, year: true },
      orderBy: [{ make: 'asc' }, { model: 'asc' }],
    });
  }
}
