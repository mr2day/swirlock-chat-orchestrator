import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AuthModule } from './auth/auth.module';
import { ChatModule } from './chat/chat.module';
import { ConfigModule } from './config/config.module';
import { CorrelationIdMiddleware } from './common/correlation-id.middleware';
import { ErrorEnvelopeFilter } from './common/error-envelope.filter';
import { DatabaseModule } from './database/database.module';

@Module({
  imports: [ConfigModule, DatabaseModule, AuthModule, ChatModule],
  providers: [{ provide: APP_FILTER, useClass: ErrorEnvelopeFilter }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationIdMiddleware).forRoutes('*');
  }
}
