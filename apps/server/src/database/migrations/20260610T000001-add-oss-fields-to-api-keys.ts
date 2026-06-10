import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('api_keys')
    .addColumn('public_id', 'text')
    .addColumn('secret_hash', 'text')
    .addColumn('description', 'text')
    .addColumn('status', 'text', (col) => col.notNull().defaultTo('active'))
    .addColumn('revoked_at', 'timestamptz')
    .addColumn('revoked_by_user_id', 'uuid', (col) => col.references('users.id').onDelete('set null'))
    .execute();

  await db
    .updateTable('api_keys')
    .set({
      public_id: sql`concat('legacy_', id::text)`,
      secret_hash: sql`''`,
    })
    .where('public_id', 'is', null)
    .execute();

  await db.schema
    .alterTable('api_keys')
    .alterColumn('public_id', (col) => col.setNotNull())
    .alterColumn('secret_hash', (col) => col.setNotNull())
    .execute();

  await db.schema
    .createIndex('api_keys_workspace_status_idx')
    .on('api_keys')
    .column('workspace_id')
    .column('status')
    .execute();

  await db.schema
    .createIndex('api_keys_creator_status_idx')
    .on('api_keys')
    .column('creator_id')
    .column('status')
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropIndex('api_keys_workspace_status_idx').execute();
  await db.schema.dropIndex('api_keys_creator_status_idx').execute();
  await db.schema.dropIndex('api_keys_public_id_unique').ifExists().execute();

  await db.schema
    .alterTable('api_keys')
    .dropColumn('public_id')
    .dropColumn('secret_hash')
    .dropColumn('description')
    .dropColumn('status')
    .dropColumn('revoked_at')
    .dropColumn('revoked_by_user_id')
    .execute();
}
