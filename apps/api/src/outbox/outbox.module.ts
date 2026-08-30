import { Module } from '@nestjs/common';
import { OutboxRelay } from './outbox.relay';
import { HoldSweeper } from '../holds/hold-sweeper.service';

@Module({
  providers: [OutboxRelay, HoldSweeper],
})
export class BackgroundJobsModule {}
