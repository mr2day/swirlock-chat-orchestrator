import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { LlmHostModule } from '../llm-host/llm-host.module';
import { RagModule } from '../rag/rag.module';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { ChatStreamHandler } from './chat-stream.handler';
import { PromptBuilderService } from './prompt-builder.service';
import { TurnPlannerService } from './turn-planner.service';

@Module({
  imports: [AuthModule, LlmHostModule, RagModule],
  controllers: [ChatController],
  providers: [
    ChatService,
    ChatStreamHandler,
    TurnPlannerService,
    PromptBuilderService,
  ],
  exports: [ChatStreamHandler],
})
export class ChatModule {}
