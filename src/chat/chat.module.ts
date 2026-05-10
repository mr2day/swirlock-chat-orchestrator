import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FragmenterModule } from '../fragmenter/fragmenter.module';
import { LlmHostModule } from '../llm-host/llm-host.module';
import { RagModule } from '../rag/rag.module';
import { CappingModule } from './capping/capping.module';
import { ChatSessionService } from './chat-session.service';
import { ChatStreamHandler } from './chat-stream.handler';
import { ConversationFlowService } from './conversation/conversation-flow.service';
import { ConversationHistoryService } from './conversation/conversation-history.service';
import { ConversationPromptBuilderService } from './conversation/conversation-prompt-builder.service';
import { DecisionsModule } from './decisions/decisions.module';
import { LocationModule } from './location/location.module';
import { PersonaIdentityService } from './persona/persona-identity.service';
import { DecisionTraceService } from './trace/decision-trace.service';

@Module({
  imports: [
    AuthModule,
    LlmHostModule,
    RagModule,
    FragmenterModule,
    LocationModule,
    CappingModule,
    DecisionsModule,
  ],
  providers: [
    ChatSessionService,
    ChatStreamHandler,
    ConversationFlowService,
    ConversationHistoryService,
    ConversationPromptBuilderService,
    DecisionTraceService,
    PersonaIdentityService,
  ],
  exports: [ChatStreamHandler],
})
export class ChatModule {}
