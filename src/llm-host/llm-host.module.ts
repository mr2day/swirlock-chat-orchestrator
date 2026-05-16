import { Module } from '@nestjs/common';
import { LlmHostService } from './llm-host.service';
import { PromptBudgetService } from './prompt-budget.service';
import { UtilityLlmHostService } from './utility-llm-host.service';

@Module({
  providers: [LlmHostService, PromptBudgetService, UtilityLlmHostService],
  exports: [LlmHostService, PromptBudgetService, UtilityLlmHostService],
})
export class LlmHostModule {}
