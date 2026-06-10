import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';

neonConfig.webSocketConstructor = ws;

async function main() {
  const file = process.argv[2];
  if (!file) {
    throw new Error('Usage: ts-node scripts/applyMigration.ts <path-to-migration.sql>');
  }
  const sql = fs.readFileSync(path.resolve(file), 'utf8');

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    console.log(`Applying migration: ${file}`);
    await pool.query(sql);
    console.log('Migration applied successfully.');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
