import { Injectable } from '@nestjs/common';
import { ApiKeyService } from '../../core/api-key/api-key.service';
import { McpPrincipal } from './mcp-auth.guard';

@Injectable()
export class McpAuthService {
  constructor(private readonly apiKeyService: ApiKeyService) {}

  async getPrincipal(token: string): Promise<McpPrincipal> {
    const { key } = await this.apiKeyService.validateBearerToken(token);
    return {
      apiKeyId: key.id,
      publicId: key.public_id,
      workspaceId: key.workspace_id,
      creatorId: key.creator_id,
    };
  }
}
