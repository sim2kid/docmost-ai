import { Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely } from 'kysely';
import { DB } from '../../database/types/db';
import { ApiKeyRepo } from '../../database/repos/api-key/api-key.repo';
import { ApiKeyGrantRepo } from '../../database/repos/api-key/api-key-grant.repo';
import { TokenService } from './token.service';
import * as bcrypt from 'bcrypt';

@Injectable()
export class ApiKeyService {
  constructor(
    @InjectKysely() private readonly db: Kysely<DB>,
    private readonly apiKeyRepo: ApiKeyRepo,
    private readonly apiKeyGrantRepo: ApiKeyGrantRepo,
    private readonly tokenService: TokenService,
  ) {}

  async createKey(user: any, workspaceId: string, dto: any) {
    return this.db.transaction().execute(async (trx) => {
    const publicId = this.tokenService.generatePublicId();
    const secret = this.tokenService.generateSecret();
    const secretHash = await bcrypt.hash(secret, 10);

    const key = await trx
      .insertInto('api_keys')
      .values({
        name: dto.name,
        description: dto.description,
        creator_id: user.id,
        workspace_id: workspaceId,
        public_id: publicId,
        secret_hash: secretHash,
        status: 'active',
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    if (dto.grants && dto.grants.length > 0) {
      for (const grant of dto.grants) {
        await trx
          .insertInto('api_key_space_grants')
          .values({
            api_key_id: key.id,
            space_id: grant.spaceId,
            scope: grant.scope,
          })
          .execute();
      }
    }

    return {
      key: {
        id: key.id,
        name: key.name,
        publicId: key.public_id,
      },
      token: this.tokenService.buildToken(publicId, secret),
    };
    });
  }

  async listKeys(user: any, workspaceId: string) {
    return await this.db
      .selectFrom('api_keys')
      .where('workspace_id', '=', workspaceId)
      .where('creator_id', '=', user.id)
      .selectAll()
      .execute();
  }

  async updateKey(user: any, workspaceId: string, keyId: string, dto: any) {
    const key = await this.db
      .selectFrom('api_keys')
      .where('id', '=', keyId)
      .where('workspace_id', '=', workspaceId)
      .where('creator_id', '=', user.id)
      .executeTakeFirstOrThrow();

    await this.db
      .updateTable('api_keys')
      .set({
        name: dto.name ?? key.name,
        description: dto.description ?? key.description,
        status: dto.status ?? key.status,
      })
      .where('id', '=', keyId)
      .execute();

    return this.db
      .selectFrom('api_keys')
      .where('id', '=', keyId)
      .executeTakeFirst();
  }

  async revokeKey(user: any, workspaceId: string, keyId: string) {
    const key = await this.db
      .selectFrom('api_keys')
      .where('id', '=', keyId)
      .where('workspace_id', '=', workspaceId)
      .where('creator_id', '=', user.id)
      .executeTakeFirstOrThrow();

    await this.db
      .updateTable('api_keys')
      .set({
        status: 'revoked',
        revoked_at: new Date(),
        revoked_by_user_id: user.id,
      })
      .where('id', '=', keyId)
      .execute();

    return { revoked: true };
  }

  async validateBearerToken(token: string) {
    const parsed = this.tokenService.parseToken(token);
    if (!parsed) throw new UnauthorizedException('Invalid token format');

    const { publicId, secret, checksum } = parsed;

    if (!this.tokenService.verifyChecksum(publicId, secret, checksum)) {
      throw new UnauthorizedException('Invalid token checksum');
    }

    const key = await this.db
      .selectFrom('api_keys')
      .where('public_id', '=', publicId)
      .where('status', '=', 'active')
      .executeTakeFirst();

    if (!key) throw new UnauthorizedException('Invalid or revoked API key');

    const isValid = await bcrypt.compare(secret, key.secret_hash);
    if (!isValid) throw new UnauthorizedException('Invalid API key secret');

    void this.touchLastUsedAt(key.id);

    return {
      key,
      grants: await this.db
        .selectFrom('api_key_space_grants')
        .where('api_key_id', '=', key.id)
        .selectAll()
        .execute(),
    };
  }

  async touchLastUsedAt(keyId: string) {
    // Throttled update: only if last_used_at is older than 1 hour
    const key = await this.db
      .selectFrom('api_keys')
      .select('last_used_at')
      .where('id', '=', keyId)
      .executeTakeFirst();

    if (key?.last_used_at) {
      const lastUsed = new Date(key.last_used_at).getTime();
      const now = Date.now();
      if (now - lastUsed < 3600000) return;
    }

    await this.db
      .updateTable('api_keys')
      .set({ last_used_at: new Date() })
      .where('id', '=', keyId)
      .execute();
  }

  async getPrincipalForKey(apiKey: any) {
    return {
      id: apiKey.id,
      publicId: apiKey.public_id,
      workspaceId: apiKey.workspace_id,
      creatorId: apiKey.creator_id,
      status: apiKey.status,
    };
  }
}
