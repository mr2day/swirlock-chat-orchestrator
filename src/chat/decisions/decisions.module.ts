import { Module } from '@nestjs/common';
import { LlmHostModule } from '../../llm-host/llm-host.module';
import { CappingModule } from '../capping/capping.module';
import { DecisionsService } from './decisions.service';

@Module({
  imports: [LlmHostModule, CappingModule],
  providers: [DecisionsService],
  exports: [DecisionsService],
})
export class DecisionsModule {}
