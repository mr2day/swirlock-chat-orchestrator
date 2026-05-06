import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { LlmHostModule } from '../llm-host/llm-host.module';
import { RagModule } from '../rag/rag.module';
import { ChatService } from './chat.service';
import { ChatStreamHandler } from './chat-stream.handler';
import { PromptBuilderService } from './prompt-builder.service';
import { TurnPlannerService } from './turn-planner.service';
import { UtilityTurnClassifierService } from './utility-turn-classifier.service';

@Module({
  imports: [AuthModule, LlmHostModule, RagModule],
  providers: [
    ChatService,
    ChatStreamHandler,
    TurnPlannerService,
    UtilityTurnClassifierService,
    PromptBuilderService,
  ],
  exports: [ChatStreamHandler],
})
export class ChatModule {}
