import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  AuthenticatedRequest,
  BearerAuthGuard,
} from '../auth/bearer-auth.guard';
import type { CorrelatedRequest } from '../common/correlation-id.middleware';
import { ChatService } from './chat.service';
import { CreateSessionDto } from './dto/create-session.dto';
import { SubmitTurnDto } from './dto/submit-turn.dto';

type AuthedRequest = AuthenticatedRequest & CorrelatedRequest;

@Controller('v2/chat/sessions')
@UseGuards(BearerAuthGuard)
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  @Post()
  @HttpCode(201)
  createSession(@Body() body: CreateSessionDto, @Req() req: AuthedRequest) {
    return this.chat.createSession({
      dto: body,
      correlationId: req.correlationId ?? '',
      authUserId: req.user!.userId,
    });
  }

  @Get(':sessionId')
  getSession(
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Req() req: AuthedRequest,
  ) {
    return this.chat.getSession({
      sessionId,
      correlationId: req.correlationId ?? '',
      authUserId: req.user!.userId,
    });
  }

  @Delete(':sessionId')
  @HttpCode(200)
  deleteSession(
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Req() req: AuthedRequest,
  ) {
    return this.chat.deleteSession({
      sessionId,
      correlationId: req.correlationId ?? '',
      authUserId: req.user!.userId,
    });
  }

  @Post(':sessionId/turns')
  @HttpCode(200)
  submitTurn(
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Body() body: SubmitTurnDto,
    @Req() req: AuthedRequest,
  ) {
    return this.chat.submitTurn({
      sessionId,
      dto: body,
      correlationId: req.correlationId ?? '',
      authUserId: req.user!.userId,
    });
  }
}
