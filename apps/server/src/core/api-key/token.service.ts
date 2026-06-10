import { Injectable } from '@nestjs/common';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class TokenService {
  private readonly serverKey: string;

  constructor(private readonly configService: ConfigService) {
    this.serverKey = this.configService.getOrThrow<string>('APP_SECRET');
  }

  generateSecret(): string {
    return randomBytes(32).toString('hex');
  }

  generatePublicId(): string {
    return randomBytes(12).toString('hex');
  }

  calculateChecksum(publicId: string, secret: string): string {
    return createHmac('sha256', this.serverKey)
      .update(`${publicId}:${secret}`)
      .digest('hex')
      .substring(0, 8);
  }

  buildToken(publicId: string, secret: string): string {
    const checksum = this.calculateChecksum(publicId, secret);
    return `dmk_${publicId}_${secret}_${checksum}`;
  }

  parseToken(token: string): { publicId: string; secret: string; checksum: string } | null {
    if (!token.startsWith('dmk_')) return null;
    const parts = token.substring(4).split('_');
    if (parts.length !== 3) return null;
    return {
      publicId: parts[0],
      secret: parts[1],
      checksum: parts[2],
    };
  }

  verifyChecksum(publicId: string, secret: string, checksum: string): boolean {
    const expected = this.calculateChecksum(publicId, secret);
    return timingSafeEqual(Buffer.from(checksum), Buffer.from(expected));
  }
}
