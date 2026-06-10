import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely } from 'kysely';
import { DB } from '../../database/types/db';

@Injectable()
export class ApiKeyRepo {
  constructor(@InjectKysely() private readonly db: Kysely<DB>) {}

  // TODO: Implement DB methods
}
