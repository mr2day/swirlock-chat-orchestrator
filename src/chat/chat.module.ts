import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FragmenterModule } from '../fragmenter/fragmenter.module';
import { LlmHostModule } from '../llm-host/llm-host.module';
import { RagModule } from '../rag/rag.module';
import { ChatSessionService } from './chat-session.service';
import { ChatStreamHandler } from './chat-stream.handler';
import { AgentContinueOptionsCommand } from './commands/agent-continue-options.command';
import { LocationRequestCommand } from './commands/location-request.command';
import { PlanCreateCommand } from './commands/plan-create.command';
import { PlanUpdateCommand } from './commands/plan-update.command';
import { RagRetrieveCommand } from './commands/rag-retrieve.command';
import { ControlLoopService } from './control/control-loop.service';
import { ControlPromptBuilderService } from './control/control-prompt-builder.service';
import { ConversationFlowService } from './conversation/conversation-flow.service';
import { ConversationHistoryService } from './conversation/conversation-history.service';
import { ConversationPromptBuilderService } from './conversation/conversation-prompt-builder.service';
import { PersonaIdentityService } from './persona/persona-identity.service';
import { AgentTraceService } from './trace/agent-trace.service';

@Module({
  imports: [AuthModule, LlmHostModule, RagModule, FragmenterModule],
  providers: [
    ChatSessionService,
    ChatStreamHandler,
    ConversationFlowService,
    ConversationHistoryService,
    ConversationPromptBuilderService,
    ControlLoopService,
    ControlPromptBuilderService,
    AgentTraceService,
    PersonaIdentityService,
    RagRetrieveCommand,
    LocationRequestCommand,
    AgentContinueOptionsCommand,
    PlanCreateCommand,
    PlanUpdateCommand,
  ],
  exports: [ChatStreamHandler],
})
export class ChatModule {}
