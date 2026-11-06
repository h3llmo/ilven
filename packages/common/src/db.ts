import pg from "pg";
import { env, envInt, secret } from "./config.ts";

export type Db = pg.Pool;
export interface Migration { id: string; sql: string }

/** Pool from DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD(_FILE). */
export function createDb(): Db {
  return new pg.Pool({
    host: env("DB_HOST"),
    port: envInt("DB_PORT", 5432),
    database: env("DB_NAME"),
    user: env("DB_USER"),
    password: secret("DB_PASSWORD"),
    max: 10,
  });
}

/** Apply pending migrations in order, each in its own transaction. Runs inside the container at startup. */
export async function migrate(db: Db, migrations: Migration[]) {
  await db.query(`CREATE TABLE IF NOT EXISTS _migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const lock = 7_241_001;
  const c = await db.connect();
  try {
    await c.query("SELECT pg_advisory_lock($1)", [lock]);
    const done = new Set((await c.query<{ id: string }>("SELECT id FROM _migrations")).rows.map((r) => r.id));
    for (const m of migrations) {
      if (done.has(m.id)) continue;
      await c.query("BEGIN");
      try {
        await c.query(m.sql);
        await c.query("INSERT INTO _migrations (id) VALUES ($1)", [m.id]);
        await c.query("COMMIT");
        console.log(`[migrate] applied ${m.id}`);
      } catch (e) {
        await c.query("ROLLBACK");
        throw e;
      }
    }
  } finally {
    await c.query("SELECT pg_advisory_unlock($1)", [lock]).catch(() => {});
    c.release();
  }
}
