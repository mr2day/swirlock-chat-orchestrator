import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUrl,
  Min,
  ValidateNested,
} from 'class-validator';
import { RequestContextDto } from './request-context.dto';

/**
 * Heterogeneous text/image input part. The contract uses a tagged union, but
 * class-validator handles unions awkwardly, so we express it as one class with
 * optional fields and validate the type-specific shape in `ChatService`.
 */
export class InputPartDto {
  @IsIn(['text', 'image'])
  type!: 'text' | 'image';

  @IsOptional()
  @IsString()
  text?: string;

  @IsOptional()
  @IsString()
  imageId?: string;

  @IsOptional()
  @IsUrl({ require_tld: false })
  imageUrl?: string;

  @IsOptional()
  @IsString()
  mimeType?: string;
}

class MessageDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => InputPartDto)
  parts!: InputPartDto[];

  @IsISO8601()
  occurredAt!: string;
}

class OptionsDto {
  @IsOptional()
  @IsIn(['blocking'])
  responseMode?: 'blocking';

  @IsOptional()
  @IsInt()
  @Min(1)
  maxOutputTokens?: number;

  @IsOptional()
  @IsBoolean()
  includeDiagnostics?: boolean;

  /**
   * Orchestrator extension beyond the v2 OpenAPI: when streaming, request
   * upstream `thinking` events from the Model Host. Ignored on the blocking
   * endpoint. Defaults to `true` on the streaming endpoint.
   */
  @IsOptional()
  @IsBoolean()
  thinking?: boolean;
}

export class SubmitTurnDto {
  @ValidateNested()
  @Type(() => RequestContextDto)
  requestContext!: RequestContextDto;

  @IsOptional()
  @IsString()
  clientTurnId?: string;

  @ValidateNested()
  @Type(() => MessageDto)
  message!: MessageDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => OptionsDto)
  options?: OptionsDto;
}
