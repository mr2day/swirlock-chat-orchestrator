import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { LlmHostModule } from '../llm-host/llm-host.module';
import { RagModule } from '../rag/rag.module';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { ChatStreamHandler } from './chat-stream.handler';

@Module({
  imports: [AuthModule, LlmHostModule, RagModule],
  controllers: [ChatController],
  providers: [ChatService, ChatStreamHandler],
  exports: [ChatStreamHandler],
})
export class ChatModule {}
