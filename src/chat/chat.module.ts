import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FragmenterModule } from '../fragmenter/fragmenter.module';
import { LlmHostModule } from '../llm-host/llm-host.module';
import { RagModule } from '../rag/rag.module';
import { CappingModule } from './capping/capping.module';
import { ChatSessionService } from './chat-session.service';
import { ChatStreamHandler } from './chat-stream.handler';
import { ConversationHistoryService } from './conversation/conversation-history.service';
import { LocationModule } from './location/location.module';
import { PersonaIdentityService } from './persona/persona-identity.service';
import { NeedFulfillerService } from './reverse-control/need-fulfiller.service';
import { ReverseControlFlowService } from './reverse-control/reverse-control-flow.service';
import { DecisionTraceService } from './trace/decision-trace.service';

@Module({
  imports: [
    AuthModule,
    LlmHostModule,
    RagModule,
    FragmenterModule,
    LocationModule,
    CappingModule,
  ],
  providers: [
    ChatSessionService,
    ChatStreamHandler,
    ConversationHistoryService,
    DecisionTraceService,
    NeedFulfillerService,
    PersonaIdentityService,
    ReverseControlFlowService,
  ],
  exports: [ChatStreamHandler],
})
export class ChatModule {}
