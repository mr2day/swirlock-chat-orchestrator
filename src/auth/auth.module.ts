import { Module } from '@nestjs/common';
import { BearerAuthGuard } from './bearer-auth.guard';

@Module({
  providers: [BearerAuthGuard],
  exports: [BearerAuthGuard],
})
export class AuthModule {}
