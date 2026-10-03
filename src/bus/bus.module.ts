import { Global, Module } from '@nestjs/common';
import { BusService } from './bus.service.js';

@Global()
@Module({
  providers: [BusService],
  exports: [BusService],
})
export class BusModule {}
