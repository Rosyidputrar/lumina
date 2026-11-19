#!/usr/bin/env node
/**
 * One-way copy utility: SQLite -> Neon/PostgreSQL.
 * It never changes LUMINA_DB or application runtime mode. Run only after taking
 * a deployment backup. It is intentionally generic so new SQLite tables are
 * copied too; the async runtime adapter is a separate, reviewed change.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';

const { Pool } = pg;
const sqliteFile = process.env.LUMINA_DB ?? process.argv[2] ?? '/data/sentinel.db';
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
if (process.env.MIGRATE_NEON_CONFIRM !== 'YES') throw new Error('Set MIGRATE_NEON_CONFIRM=YES to run the migration');
if (!fs.existsSync(sqliteFile)) throw new Error(`SQLite file not found: ${sqliteFile}`);

const backup = `${sqliteFile}.pre-neon-${new Date().toISOString().replace(/[:.]/g, '-')}.bak`;
fs.copyFileSync(sqliteFile, backup);
console.log(`backup=${backup}`);

const sqlite = new DatabaseSync(sqliteFile, { readOnly: true });
const pool = new Pool({ connectionString: databaseUrl, max: 2, connectionTimeoutMillis: 15000, ssl: { rejectUnauthorized: false } });
const ident = (v) => '"' + String(v).replaceAll('"', '""') + '"';
const lit = (v) => v === null || v === undefined ? null : v;
const typeFor = (type) => /INT/i.test(type) ? 'BIGINT' : /REAL|FLOA|DOUB|NUM/i.test(type) ? 'DOUBLE PRECISION' : /BOOL/i.test(type) ? 'BOOLEAN' : /BLOB/i.test(type) ? 'BYTEA' : 'TEXT';

try {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('CREATE TABLE IF NOT EXISTS _lumina_migration_meta (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const tables = sqlite.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    const counts = {};
    for (const table of tables) {
      const columns = sqlite.prepare(`PRAGMA table_info(${ident(table.name)})`).all();
      if (!columns.length) continue;
      const pk = columns.filter((c) => Number(c.pk) > 0).sort((a, b) => a.pk - b.pk).map((c) => ident(c.name));
      const defs = columns.map((c) => `${ident(c.name)} ${typeFor(c.type)}`).join(', ');
      const tableSql = pk.length ? `${defs}, PRIMARY KEY (${pk.join(', ')})` : defs;
      await client.query(`CREATE TABLE IF NOT EXISTS ${ident(table.name)} (${tableSql})`);
      const rows = sqlite.prepare(`SELECT * FROM ${ident(table.name)}`).all();
      counts[table.name] = rows.length;
      console.log(`table ${table.name} rows=${rows.length}`);
      // Idempotent migration: clear only this target table, then copy source truth.
      await client.query(`TRUNCATE TABLE ${ident(table.name)} CASCADE`);
      if (!rows.length) continue;
      const names = columns.map((c) => ident(c.name));
      // Batch inserts: one INSERT per 200 rows instead of one per row. A 25 MB
      // SQLite ledger is hundreds of thousands of rows and row-by-row over the
      // internet to Neon is the difference between minutes and hours.
      const BATCH = 200;
      for (let i = 0; i < rows.length; i += BATCH) {
        const slice = rows.slice(i, i + BATCH);
        const values = [];
        let n = 0;
        for (const row of slice) values.push(`(${columns.map(() => `$${++n}`).join(',')})`);
        const batchInsert = `INSERT INTO ${ident(table.name)} (${names.join(',')}) VALUES ${values.join(',')}`;
        const params = [];
        for (const row of slice) for (const c of columns) params.push(lit(row[c.name]));
        await client.query(batchInsert, params);
        if ((i / BATCH) % 25 === 0) console.log(`copy ${table.name} rows=${i + slice.length}`);
      }
    }
    await client.query('INSERT INTO _lumina_migration_meta (id,value) VALUES ($1,$2) ON CONFLICT (id) DO UPDATE SET value=EXCLUDED.value', ['last_sqlite_backup', backup]);
    await client.query('INSERT INTO _lumina_migration_meta (id,value) VALUES ($1,$2) ON CONFLICT (id) DO UPDATE SET value=EXCLUDED.value', ['source_file', sqliteFile]);
    await client.query('COMMIT');
    console.log(JSON.stringify({ ok: true, tables: Object.keys(counts).length, counts, backup }, null, 2));
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally { client.release(); }
} finally {
  sqlite.close();
  await pool.end();
}
