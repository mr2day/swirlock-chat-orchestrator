import { Module } from '@nestjs/common';
import { LlmHostService } from './llm-host.service';
import { PromptBudgetService } from './prompt-budget.service';

@Module({
  providers: [LlmHostService, PromptBudgetService],
  exports: [LlmHostService, PromptBudgetService],
})
export class LlmHostModule {}
