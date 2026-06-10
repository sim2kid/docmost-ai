import { IsString, IsUUID } from 'class-validator';

export class ApiKeyIdDto {
  @IsUUID()
  @IsString()
  id: string;
}
