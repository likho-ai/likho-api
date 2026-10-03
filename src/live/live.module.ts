import { Global, Module } from '@nestjs/common';
import { LiveService } from './live.service.js';

@Global()
@Module({
  providers: [LiveService],
  exports: [LiveService],
})
export class LiveModule {}
