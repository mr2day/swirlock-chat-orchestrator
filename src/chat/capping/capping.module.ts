import { Module } from '@nestjs/common';
import { CappingService } from './capping.service';

@Module({
  providers: [CappingService],
  exports: [CappingService],
})
export class CappingModule {}
