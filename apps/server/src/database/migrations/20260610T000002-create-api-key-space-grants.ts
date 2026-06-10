import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('api_key_space_grants')
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_uuid_v7()`),
    )
    .addColumn('api_key_id', 'uuid', (col) =>
      col.notNull().references('api_keys.id').onDelete('cascade'),
    )
    .addColumn('space_id', 'uuid', (col) =>
      col.notNull().references('spaces.id').onDelete('cascade'),
    )
    .addColumn('scope', 'text', (col) =>
      col.notNull(),
    )
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn('updated_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();

  await db.schema
    .createIndex('api_key_space_grants_api_key_space_unique')
    .unique()
    .on('api_key_space_grants')
    .columns(['api_key_id', 'space_id'])
    .execute();

  await db.schema
    .createIndex('api_key_space_grants_api_key_id_idx')
    .on('api_key_space_grants')
    .column('api_key_id')
    .execute();

  await db.schema
    .createIndex('api_key_space_grants_space_id_idx')
    .on('api_key_space_grants')
    .column('space_id')
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('api_key_space_grants').execute();
}
