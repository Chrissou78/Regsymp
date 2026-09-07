import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { createClient } from "./github.js";
import { configValue } from "./runtime-config.js";

/**
 * What is in the database: counts and names, never a hash and never a value.
 *
 * `durable: true` is not optimism — a reachable database is durable by
 * construction, which is the entire reason content moved here from a volume
 * nobody had mounted.
 */
export async function pgStatus(db) {
  try {
    const [content, revisions, admins, migrations] = await Promise.all([
      db.query("select count(*)::int n, coalesce(sum(length(body)),0)::bigint bytes from content_documents"),
      db.query("select count(*)::int n from content_revisions"),
      db.query("select count(*)::int n from admin_users"),
      db.query("select version from schema_migrations order by version")
    ]);
    return {
      backend: "postgres",
      readable: true,
      durable: true,
      documents: content.rows[0].n,
      bytes: Number(content.rows[0].bytes),
      revisions: revisions.rows[0].n,
      accounts: admins.rows[0].n,
      migrations: migrations.rows.map((r) => r.version)
    };
  } catch (err) {
    // Report the failure rather than throwing: a health endpoint that 500s
    // when the database is unreachable tells a probe nothing useful.
    return { backend: "postgres", readable: false, durable: false, reason: err.message };
  }
}

/**
 * What is actually in the content directory.
 *
 * Reports names, counts and booleans only — never a password hash and never
 * a token.
 */
export async function volumeStatus(dir) {
  const out = { dir, readable: false, accounts: 0, dataFiles: [] };
  try {
    const info = await stat(dir);
    if (!info.isDirectory()) return { ...out, reason: "not a directory" };
  } catch (err) {
    return { ...out, reason: err.code === "ENOENT" ? "does not exist" : err.message };
  }
  out.readable = true;

  try {
    out.dataFiles = (await readdir(path.join(dir, "src/_data"))).filter((n) => n.endsWith(".json"));
  } catch {
    out.reason = "no src/_data yet";
  }

  try {
    const parsed = JSON.parse(await readFile(path.join(dir, "admin/users.json"), "utf8"));
    out.accounts = Array.isArray(parsed.users) ? parsed.users.length : 0;
  } catch {
    out.accounts = 0;
  }
  return out;
}

/**
 * Can a token still read the GitHub repository?
 *
 * No longer on the save path — content lives on a volume — but still worth
 * having for an export or a one-off migration, which is why it is opt-in at
 * /api/health?github=1 rather than checked on every probe.
 */
export async function contentStatus() {
  const token = configValue("GITHUB_TOKEN");
  const repo = configValue("CONTENT_REPO") || "OC-Labs/regsymp";
  const branch = configValue("CONTENT_BRANCH") || "prod";

  if (!token) return { repo, branch, readable: false, reason: "no token (none is needed any more)" };

  try {
    const gh = createClient({ token, repo, branch });
    const file = await gh.getFile("admin/users.json");
    if (!file) {
      const status = gh.getFile.lastStatus;
      const reasons = {
        401: "token rejected by GitHub - it may be revoked, expired, or mistyped",
        403: "token lacks permission - a fine-grained token may be pending org approval",
        404: "repo, branch or file not found for this token"
      };
      return {
        repo,
        branch,
        readable: false,
        httpStatus: status ?? null,
        reason: reasons[status] ?? `admin/users.json not readable (HTTP ${status})`
      };
    }
    const parsed = JSON.parse(file.content);
    return {
      repo,
      branch,
      readable: true,
      accounts: Array.isArray(parsed.users) ? parsed.users.length : 0
    };
  } catch (err) {
    return { repo, branch, readable: false, reason: err.message };
  }
}
