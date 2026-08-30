import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { AppointmentsService } from './appointments.service';
import { readPositiveInt } from '../../common/env';
import {
  CreateAppointmentDto,
  CreateHoldDto,
  ListAppointmentsDto,
} from './appointments.dto';

/** Default reservation lifetime: long enough to fill a form, short enough not to hoard slots. */
const DEFAULT_HOLD_TTL_SECONDS = 120;

@Controller()
export class AppointmentsController {
  constructor(private readonly appointments: AppointmentsService) {}

  /**
   * Confirms an appointment (Requirements 1-3).
   *
   * With `holdId`, promotes an existing reservation; without it, books
   * directly. An `Idempotency-Key` header makes the call safe to retry.
   */
  @Post('appointments')
  async create(
    @Body() body: CreateAppointmentDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const outcome = await this.appointments.book({
      dealershipId: body.dealershipId,
      customerId: body.customerId,
      vehicleId: body.vehicleId,
      serviceTypeId: body.serviceTypeId,
      startAt: new Date(body.startAt),
      holdId: body.holdId,
      idempotencyKey,
    });

    return { ...outcome.appointment, replayed: outcome.replayed };
  }

  /** Reserves a slot briefly so it cannot be taken while the customer completes booking. */
  @Post('holds')
  async hold(@Body() body: CreateHoldDto) {
    const ttl = readPositiveInt('HOLD_TTL_SECONDS', DEFAULT_HOLD_TTL_SECONDS);
    const outcome = await this.appointments.hold(
      {
        dealershipId: body.dealershipId,
        customerId: body.customerId,
        vehicleId: body.vehicleId,
        serviceTypeId: body.serviceTypeId,
        startAt: new Date(body.startAt),
      },
      ttl,
    );

    return { ...outcome.appointment, expiresInSeconds: ttl };
  }

  @Get('appointments')
  list(@Query() query: ListAppointmentsDto) {
    return this.appointments.listForCustomer(query.customerId);
  }

  @Get('appointments/:id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.appointments.findById(id);
  }

  @Delete('appointments/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async cancel(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.appointments.cancel(id);
  }
}
