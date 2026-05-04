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

  @IsOptional()
  @IsString()
  personaId?: string;
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
  @Type(() => ClientDto)
  client?: ClientDto;
}
