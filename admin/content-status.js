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
    const [content, revisions, admins, migrations, images] = await Promise.all([
      db.query("select count(*)::int n, coalesce(sum(length(body)),0)::bigint bytes from content_documents"),
      db.query("select count(*)::int n from content_revisions"),
      db.query("select count(*)::int n from admin_users"),
      db.query("select version from schema_migrations order by version"),
      // Stored images that are not images. A body decoded as UTF-8 somewhere
      // loses every byte above 0x7F to U+FFFD, so a PNG's leading 0x89 reads
      // as EF BF BD -- and nothing downstream says so: the build declines to
      // fail over one unreadable image, and the page quietly ships a broken
      // path. This is the number that would have caught it in a day.
      db.query(
        `select count(*)::int n from content_documents
          where path ~* '[.](png|jpe?g|webp|gif)$'
            and not (
                  substring(body from 1 for 4) = $1   -- PNG
               or substring(body from 1 for 3) = $2   -- JPEG: the fourth byte
                                                      -- is the segment marker
                                                      -- and varies
               or substring(body from 1 for 4) = $3   -- RIFF, for WebP
               or substring(body from 1 for 4) = $4   -- GIF8
            )`,
        // As parameters rather than SQL literals: a bytea hex literal needs
        // exactly one backslash by the time Postgres sees it, and getting
        // that through two layers of escaping silently produced a comparison
        // that was false for every row -- which reported every image broken.
        [
          Buffer.from([0x89, 0x50, 0x4e, 0x47]),
          Buffer.from([0xff, 0xd8, 0xff]),
          Buffer.from([0x52, 0x49, 0x46, 0x46]),
          Buffer.from([0x47, 0x49, 0x46, 0x38])
        ]
      )
    ]);
    return {
      backend: "postgres",
      readable: true,
      durable: true,
      documents: content.rows[0].n,
      bytes: Number(content.rows[0].bytes),
      revisions: revisions.rows[0].n,
      accounts: admins.rows[0].n,
      // Zero, or something has decoded a binary body as text.
      brokenImages: images.rows[0].n,
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
