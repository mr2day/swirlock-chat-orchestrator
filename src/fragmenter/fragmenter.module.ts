import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { FragmenterClientService } from './fragmenter-client.service';
import { FragmenterReaderService } from './fragmenter-reader.service';

@Module({
  imports: [DatabaseModule],
  providers: [FragmenterClientService, FragmenterReaderService],
  exports: [FragmenterClientService, FragmenterReaderService],
})
export class FragmenterModule {}
