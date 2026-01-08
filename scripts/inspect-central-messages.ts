// scripts/inspect-central-messages.ts
import { PGlite } from "@electric-sql/pglite";
import 'dotenv/config';

process.env.PGLITE_DATA_DIR = '.pglite';

const dataDir = "/home/mrt0b13/agentx/.pglite"; // adjust to whatever plugin-sql is using
const db = new PGlite({ dataDir });
await db.waitReady;

const cols = await db.query(`
  select column_name, is_nullable, column_default, data_type
  from information_schema.columns
  where table_name = 'central_messages'
  order by ordinal_position
`);

console.log(cols.rows);
