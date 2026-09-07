import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

/**
 * Postgres connection and migrations.
 *
 * Content and admin accounts live here rather than in a git repository or on
 * a mounted volume. The repository route made every save a commit, and every
 * commit a redeploy, which wiped the very token that made saving work. The
 * volume route needed a mount nobody had provisioned. A database needs
 * neither, and it is durable the moment it is reachable.
 *
 * `query` is a narrow seam on purpose: the stores above it are written against
 * this shape, so they can be unit-tested without a server.
 */

const MIGRATIONS = fileURLToPath(new URL("./migrations/", import.meta.url));

export function createDb({ url, ssl = sslFromEnv(), max = 5 }) {
  const pool = new pg.Pool({
    connectionString: url,
    max,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    ...(ssl ? { ssl } : {})
  });

  // An idle client erroring must not take the process down with it.
  pool.on("error", (err) => console.error("postgres pool error:", err.message));

  return {
    query: (text, params) => pool.query(text, params),

    /**
     * Run a function inside a transaction on one client.
     * Used wherever a read and a write must agree — a save checks the current
     * digest and writes conditionally, which is not safe across two clients.
     */
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const result = await fn(client);
        await client.query("commit");
        return result;
      } catch (err) {
        await client.query("rollback").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },

    end: () => pool.end()
  };
}

/**
 * The connection crosses the public internet in our deployment, so TLS is
 * worth having — but only if the server offers it, otherwise every connection
 * fails. Opt in with DATABASE_SSL=require.
 */
function sslFromEnv() {
  const mode = String(process.env.DATABASE_SSL ?? "").trim().toLowerCase();
  if (!mode || mode === "disable") return null;
  return { rejectUnauthorized: mode !== "no-verify" };
}

/**
 * Apply any migrations that have not run yet, in filename order.
 *
 * Each runs in its own transaction, so a failure leaves the schema at the last
 * complete migration rather than half-applied. Returns what it ran, which the
 * boot log prints — silent migrations are how schema drift goes unnoticed.
 */
export async function migrate(db, dir = MIGRATIONS) {
  await db.query(`
    create table if not exists schema_migrations (
      version    text primary key,
      applied_at timestamptz not null default now()
    )
  `);

  const { rows } = await db.query("select version from schema_migrations");
  const applied = new Set(rows.map((r) => r.version));

  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const ran = [];

  for (const file of files) {
    const version = file.replace(/\.sql$/, "");
    if (applied.has(version)) continue;
    const sql = await readFile(path.join(dir, file), "utf8");
    await db.tx(async (client) => {
      await client.query(sql);
      await client.query("insert into schema_migrations (version) values ($1)", [version]);
    });
    ran.push(version);
  }
  return ran;
}
