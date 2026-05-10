import { Module } from '@nestjs/common';
import { LlmHostModule } from '../../llm-host/llm-host.module';
import { RagModule } from '../../rag/rag.module';
import { CappingModule } from '../capping/capping.module';
import { LocationModule } from '../location/location.module';
import { NeedFulfillerService } from './need-fulfiller.service';
import { ReverseControlFlowService } from './reverse-control-flow.service';

@Module({
  imports: [LlmHostModule, RagModule, LocationModule, CappingModule],
  providers: [NeedFulfillerService, ReverseControlFlowService],
  exports: [ReverseControlFlowService],
})
export class ReverseControlModule {}
