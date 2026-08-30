import { Module } from '@nestjs/common';
import { AppointmentsController } from './appointments.controller';
import { AppointmentsService } from './appointments.service';
import { BookingRepository } from './booking.repository';

@Module({
  controllers: [AppointmentsController],
  providers: [AppointmentsService, BookingRepository],
  exports: [AppointmentsService],
})
export class AppointmentsModule {}
