import { Module } from '@nestjs/common';
import { McpAuthGuard } from './auth/mcp-auth.guard';
import { McpAuthService } from './auth/mcp-auth.service';
import { ApiKeyModule } from '../../core/api-key/api-key.module';

@Module({
  imports: [ApiKeyModule],
  providers: [McpAuthGuard, McpAuthService],
  exports: [McpAuthGuard, McpAuthService],
})
export class McpAuthModule {}
