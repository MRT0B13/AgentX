import 'dotenv/config';
import { Client } from 'pg';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.log('No DATABASE_URL set; skipping central schema check.');
    return;
  }

  const client = new Client({ connectionString: url, ssl: url.includes('sslmode=require') ? { rejectUnauthorized: false } : undefined });
  await client.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS central_messages (
        id UUID PRIMARY KEY,
        channel_id UUID NOT NULL,
        author_id UUID NOT NULL,
        content TEXT,
        raw_message JSONB,
        in_reply_to_root_message_id UUID,
        source_type TEXT,
        source_id TEXT,
        metadata JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS central_messages_channel_id_idx ON central_messages(channel_id);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS central_messages_created_at_idx ON central_messages(created_at);
    `);
    console.log('central_messages schema ensured');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('ensure-central-schema failed:', err);
  process.exitCode = 1;
});
