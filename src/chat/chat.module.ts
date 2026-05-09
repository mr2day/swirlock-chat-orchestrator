import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FragmenterModule } from '../fragmenter/fragmenter.module';
import { LlmHostModule } from '../llm-host/llm-host.module';
import { RagModule } from '../rag/rag.module';
import { AgentLoopService } from './agent-loop.service';
import { AgentTraceService } from './agent-trace.service';
import { ChatService } from './chat.service';
import { ChatStreamHandler } from './chat-stream.handler';
import { PersonaIdentityService } from './persona-identity.service';

@Module({
  imports: [AuthModule, LlmHostModule, RagModule, FragmenterModule],
  providers: [
    AgentLoopService,
    AgentTraceService,
    ChatService,
    ChatStreamHandler,
    PersonaIdentityService,
  ],
  exports: [ChatStreamHandler],
})
export class ChatModule {}
