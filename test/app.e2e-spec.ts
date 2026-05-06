import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { Response } from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';

describe('Chat Orchestrator (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  it('/v2/health (GET)', () => {
    return request(app.getHttpServer())
      .get('/v2/health')
      .expect(200)
      .expect((response: Response) => {
        const body = response.body as { data?: { status?: unknown } };
        expect(body.data?.status).toBe('ok');
      });
  });

  afterEach(async () => {
    await app.close();
  });
});
