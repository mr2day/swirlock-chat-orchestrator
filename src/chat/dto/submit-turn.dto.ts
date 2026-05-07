import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  Max,
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
  imageBase64?: string;

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
  @IsInt()
  @Min(1)
  maxOutputTokens?: number;

  @IsOptional()
  @IsBoolean()
  includeDiagnostics?: boolean;

  /**
   * Allows upstream `thinking` events when the orchestrator's utility turn
   * classifier decides the turn is complex enough. Use `forceThinking` to
   * override.
   */
  @IsOptional()
  @IsBoolean()
  thinking?: boolean;

  /**
   * Explicitly force upstream `thinking` events. This is separate from the
   * legacy `thinking` boolean so older clients that always send
   * `thinking: true` still get automatic classifier behavior.
   */
  @IsOptional()
  @IsBoolean()
  forceThinking?: boolean;
}

export class UserLocationDto {
  @IsNumber()
  @Min(-90)
  @Max(90)
  latitude!: number;

  @IsNumber()
  @Min(-180)
  @Max(180)
  longitude!: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  accuracyMeters?: number;

  @IsOptional()
  @IsISO8601()
  capturedAt?: string;
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
  @Type(() => UserLocationDto)
  userLocation?: UserLocationDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => OptionsDto)
  options?: OptionsDto;
}
