import { createClient } from "./github.js";
import { configValue } from "./runtime-config.js";

/**
 * Can the configured token actually read the content repository?
 *
 * Without this, a token that is valid but lacks access is indistinguishable
 * from a missing invitation: an unreadable users file yields no accounts and
 * no invites, so every sign-in and every invite link fails with the same
 * unhelpful message.
 *
 * Reports names and booleans only — never the token.
 */
export async function contentStatus() {
  const token = configValue("GITHUB_TOKEN");
  const repo = configValue("CONTENT_REPO") || "OC-Labs/regsymp";
  const branch = configValue("CONTENT_BRANCH") || "prod";

  if (!token) return { repo, branch, readable: false, reason: "no token" };

  try {
    const gh = createClient({ token, repo, branch });
    const file = await gh.getFile("admin/users.json");
    if (!file) {
      return {
        repo,
        branch,
        readable: false,
        reason: "admin/users.json not readable — check the token's repository access"
      };
    }
    const parsed = JSON.parse(file.content);
    return {
      repo,
      branch,
      readable: true,
      accounts: Array.isArray(parsed.users) ? parsed.users.length : 0,
      pendingInvites: Array.isArray(parsed.invites) ? parsed.invites.length : 0
    };
  } catch (err) {
    return { repo, branch, readable: false, reason: err.message };
  }
}
