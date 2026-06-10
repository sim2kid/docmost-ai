import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AuthUser } from '../auth/decorators/auth-user.decorator';
import { AuthWorkspace } from '../auth/decorators/auth-workspace.decorator';
import { ApiKeyService } from './api-key.service';
import { CreateApiKeyDto } from './dto/create-api-key.dto';
import { UpdateApiKeyDto } from './dto/update-api-key.dto';
import { ApiKeyIdDto } from './dto/api-key-id.dto';

@Controller('api/api-keys')
@UseGuards(JwtAuthGuard)
export class ApiKeyController {
  constructor(private readonly apiKeyService: ApiKeyService) {}

  @Post()
  async create(@AuthUser() user: any, @AuthWorkspace() workspace: any, @Body() dto: CreateApiKeyDto) {
    return this.apiKeyService.createKey(user, workspace.id, dto);
  }

  @Get()
  async list(@AuthUser() user: any, @AuthWorkspace() workspace: any) {
    return this.apiKeyService.listKeys(user, workspace.id);
  }

  @Patch(':id')
  async update(@AuthUser() user: any, @AuthWorkspace() workspace: any, @Param() params: ApiKeyIdDto, @Body() dto: UpdateApiKeyDto) {
    return this.apiKeyService.updateKey(user, workspace.id, params.id, dto);
  }

  @Delete(':id')
  async revoke(@AuthUser() user: any, @AuthWorkspace() workspace: any, @Param() params: ApiKeyIdDto) {
    return this.apiKeyService.revokeKey(user, workspace.id, params.id);
  }
}
