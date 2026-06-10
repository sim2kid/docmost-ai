export interface ApiKey {
  id: string;
  publicId: string;
  name: string;
  description?: string;
  creatorId: string;
  workspaceId: string;
  status: 'active' | 'revoked';
  expiresAt?: Date;
  lastUsedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  revokedAt?: Date;
  revokedByUserId?: string;
}

export interface ApiKeyGrant {
  id: string;
  apiKeyId: string;
  spaceId: string;
  scope: 'read_only' | 'read_write';
  createdAt: Date;
  updatedAt: Date;
}
