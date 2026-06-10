import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ApiKeyService } from '../../core/api-key/api-key.service';

export interface McpPrincipal {
  apiKeyId: string;
  publicId: string;
  workspaceId: string;
  creatorId: string;
}

@Injectable()
export class McpAuthGuard implements CanActivate {
  constructor(private readonly apiKeyService: ApiKeyService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing or invalid authorization header');
    }

    const token = authHeader.substring(7);
    try {
      const { key, grants } = await this.apiKeyService.validateBearerToken(token);

      // Attach principal and context for downstream use
      request.mcpPrincipal = {
        apiKeyId: key.id,
        publicId: key.public_id,
        workspaceId: key.workspace_id,
        creatorId: key.creator_id,
      };

      request.mcpGrants = grants;

      // Compatibility with existing workspace-dependent code
      request.raw.workspaceId = key.workspace_id;
      request.raw.workspace = { id: key.workspace_id };

      return true;
    } catch (e) {
      throw new UnauthorizedException(e instanceof Error ? e.message : 'Unauthorized');
    }
  }
}
