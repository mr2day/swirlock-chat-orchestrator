import { Module } from '@nestjs/common';
import { FragmenterClientService } from './fragmenter-client.service';

@Module({
  providers: [FragmenterClientService],
  exports: [FragmenterClientService],
})
export class FragmenterModule {}
