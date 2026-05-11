import { Module } from '@nestjs/common';
import { JwtVerifier } from './jwt-verifier';

@Module({
  providers: [JwtVerifier],
  exports: [JwtVerifier],
})
export class AuthModule {}
