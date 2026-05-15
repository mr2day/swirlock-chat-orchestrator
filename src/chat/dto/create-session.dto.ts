import { Type } from 'class-transformer';
import { IsOptional, IsString, ValidateNested } from 'class-validator';
import { RequestContextDto } from './request-context.dto';

class ParticipantDto {
  @IsString()
  userId!: string;

  @IsOptional()
  @IsString()
  displayName?: string;
}

class AppDto {
  @IsString()
  appId!: string;
}

/**
 * Per-session persona variable supplied by the client app.
 *
 * The orchestrator does not own persona definitions; it holds whatever
 * the client app sends here for the lifetime of the session and pipes
 * `systemPrompt` to the LLM on every turn. The client app is the single
 * source of truth for persona name, prompt, and any persona-side state.
 */
class PersonaDto {
  /**
   * Stable UI-side persona identifier (kebab-case, e.g.
   * `marcello-voltieri`). Used to scope `session.list` so each
   * persona sees only its own conversation history. Optional for
   * backward compatibility with legacy clients that only sent
   * `name` + `systemPrompt`.
   */
  @IsOptional()
  @IsString()
  id?: string;

  @IsString()
  name!: string;

  @IsString()
  systemPrompt!: string;
}

class ClientDto {
  @IsOptional()
  @IsString()
  channel?: string;

  @IsOptional()
  @IsString()
  clientVersion?: string;
}

export class CreateSessionDto {
  @ValidateNested()
  @Type(() => RequestContextDto)
  requestContext!: RequestContextDto;

  @ValidateNested()
  @Type(() => ParticipantDto)
  participant!: ParticipantDto;

  @ValidateNested()
  @Type(() => AppDto)
  app!: AppDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => PersonaDto)
  persona?: PersonaDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => ClientDto)
  client?: ClientDto;
}
