const API = "https://api.github.com";

/**
 * Raised when the file changed between load and save. The Contents API
 * requires the blob SHA of the file being replaced, which gives us
 * optimistic concurrency for free: a stale SHA is rejected rather than
 * silently overwriting someone else's edit.
 */
export class ConflictError extends Error {
  constructor(message = "The file changed since you loaded it.") {
    super(message);
    this.name = "ConflictError";
  }
}

/**
 * Minimal GitHub Contents API client.
 *
 * `fetchImpl` is injectable so tests never touch the network and never
 * commit anything.
 */
export function createClient({ token, repo, branch, fetchImpl = fetch }) {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "regsymp-admin"
  };

  async function getFile(path) {
    const url = `${API}/repos/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`;
    const res = await fetchImpl(url, { headers });
    // Record the status so callers can tell "bad token" from "no access" from
    // "wrong repo". Returning a bare null made all three look identical.
    getFile.lastStatus = res.status;
    if (!res.ok) return null;
    const body = await res.json();
    return {
      content: Buffer.from(body.content ?? "", "base64").toString("utf8"),
      sha: body.sha
    };
  }

  async function putFile({ path, content, message, sha, isBinary = false }) {
    const url = `${API}/repos/${repo}/contents/${path}`;
    const encoded = isBinary
      ? Buffer.from(content).toString("base64")
      : Buffer.from(String(content), "utf8").toString("base64");

    const res = await fetchImpl(url, {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        content: encoded,
        branch,
        ...(sha ? { sha } : {})
      })
    });

    if (res.ok) {
      const body = await res.json();
      return { commit: { sha: body.commit?.sha, htmlUrl: body.commit?.html_url } };
    }

    const err = await res.json().catch(() => ({}));
    if (res.status === 409 || res.status === 422) throw new ConflictError(err.message);
    throw new Error(err.message || `GitHub returned ${res.status}`);
  }

  return { getFile, putFile };
}
