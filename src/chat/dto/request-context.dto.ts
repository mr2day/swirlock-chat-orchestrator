import {
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

export class RequestContextDto {
  @IsString()
  callerService!: string;

  @IsOptional()
  @IsIn(['interactive', 'background', 'maintenance'])
  priority?: 'interactive' | 'background' | 'maintenance';

  @IsISO8601()
  requestedAt!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  timeoutMs?: number;

  @IsOptional()
  @IsBoolean()
  debug?: boolean;
}
