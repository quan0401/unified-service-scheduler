import { Controller, Get, Query } from '@nestjs/common';
import { AvailabilityService } from './availability.service';
import { AvailabilityQueryDto, type AvailabilityView } from './availability.dto';

@Controller('availability')
export class AvailabilityController {
  constructor(private readonly availability: AvailabilityService) {}

  /**
   * Slot grid for one dealership, service type, and local calendar date.
   *
   * Advisory only: a slot reported free can be taken by another customer a
   * moment later. Booking re-checks atomically, so this endpoint is a view, not
   * a reservation.
   */
  @Get()
  get(@Query() query: AvailabilityQueryDto): Promise<AvailabilityView> {
    return this.availability.getAvailability(query.dealershipId, query.serviceTypeId, query.date);
  }
}
