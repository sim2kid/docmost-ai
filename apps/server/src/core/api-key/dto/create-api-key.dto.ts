import { IsString, IsOptional, IsArray, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

class SpaceGrantDto {
  @IsString()
  spaceId: string;

  @IsString()
  scope: 'read_only' | 'read_write';
}

export class CreateApiKeyDto {
  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SpaceGrantDto)
  grants?: SpaceGrantDto[];
}
