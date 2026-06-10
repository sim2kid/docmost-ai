import { Module } from '@nestjs/common';
import { ApiKeyController } from './api-key.controller';
import { ApiKeyService } from './api-key.service';
import { TokenService } from './token.service';
import { ApiKeyRepo } from '../../database/repos/api-key/api-key.repo';
import { ApiKeyGrantRepo } from '../../database/repos/api-key/api-key-grant.repo';

@Module({
  controllers: [ApiKeyController],
  providers: [
    ApiKeyService,
    TokenService,
    ApiKeyRepo,
    ApiKeyGrantRepo,
  ],
  exports: [ApiKeyService],
})
export class ApiKeyModule {}
