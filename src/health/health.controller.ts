import { Controller, Get, Inject, Req } from '@nestjs/common';
import { SERVICE_CONFIG } from '../config/config';
import type { ServiceConfig } from '../config/config';
import { buildMeta } from '../common/meta.util';
import type { CorrelatedRequest } from '../common/correlation-id.middleware';

@Controller('v2/health')
export class HealthController {
  constructor(@Inject(SERVICE_CONFIG) private readonly cfg: ServiceConfig) {}

  @Get()
  health(@Req() req: CorrelatedRequest) {
    return {
      meta: buildMeta(req.correlationId ?? '', this.cfg.apiVersion),
      data: { status: 'ok' as const, ready: true },
    };
  }
}
