import { randomBytes } from "node:crypto";
import { SCHEMAS, getSchema, validateRecord } from "./schemas.js";
import { createClient, ConflictError } from "./github.js";
import { csrfToken, parseCookies, verifyCsrf } from "./auth.js";
import { createUserStore } from "./users-store.js";
import { createAttemptLimiter } from "./login-attempts.js";
import { escape, errorList, field, layout } from "./render.js";
import { boundaryFrom, detectImageType, parseMultipart } from "./multipart.js";
import { slugifyFilename } from "./sanitise.js";

const COOKIE = "regsymp_admin";
const MAX_BODY = 12 * 1024 * 1024;
const MAX_IMAGE = 8 * 1024 * 1024;

/* ------------------------------------------------------------------ pure
 * These are exported so they can be tested without HTTP, sessions or the
 * GitHub API. Every route handler is a thin wrapper over them.
 * ------------------------------------------------------------------ */

export function serialise(data) {
  return JSON.stringify(data, null, 2) + "\n";
}

/**
 * Every collection reduces to "an array somewhere in the document":
 *   array   -> the document itself
 *   nested  -> doc[i].logos, addressed as "0"
 *   agenda  -> doc.palma.day1, addressed as "palma.day1"
 * `site` has no list; it is edited as a single record.
 */
export function resolveList(schema, doc, listKey) {
  if (schema.kind === "array") return Array.isArray(doc) ? doc : [];
  if (schema.kind === "nested") {
    if (listKey === undefined || listKey === "") return Array.isArray(doc) ? doc : [];
    const group = doc[Number(listKey)];
    return group ? (group[schema.childKey] ?? []) : [];
  }
  if (schema.kind === "agenda") {
    if (!listKey) return [];
    const [edition, day] = String(listKey).split(".");
    return doc?.[edition]?.[day] ?? [];
  }
  return [];
}

export function setList(schema, doc, listKey, list) {
  if (schema.kind === "array") return list;
  if (schema.kind === "nested") {
    if (listKey === undefined || listKey === "") return list;
    const next = doc.map((g) => ({ ...g }));
    next[Number(listKey)] = { ...next[Number(listKey)], [schema.childKey]: list };
    return next;
  }
  if (schema.kind === "agenda") {
    const [edition, day] = String(listKey).split(".");
    return { ...doc, [edition]: { ...doc[edition], [day]: list } };
  }
  return doc;
}

export function applyEdit(schema, list, index, input, fields = schema.fields) {
  const { ok, value, errors } = validateRecord(schema, input, fields);
  if (!ok) return { ok: false, errors, list };

  for (const f of fields.filter((x) => x.unique)) {
    const clash = list.some(
      (record, i) => String(i) !== String(index) && record[f.name] === value[f.name]
    );
    if (clash) {
      return {
        ok: false,
        list,
        errors: [{ field: f.name, message: `${f.name} "${value[f.name]}" is already used.` }]
      };
    }
  }

  const next = list.slice();
  if (index === "new") next.push(value);
  else next[Number(index)] = value;
  return { ok: true, list: next, errors: [] };
}

export function applyDelete(list, index) {
  const next = list.slice();
  next.splice(Number(index), 1);
  return next;
}

export function applyMove(list, index, direction) {
  const i = Number(index);
  const j = direction === "up" ? i - 1 : i + 1;
  const next = list.slice();
  if (i < 0 || i >= list.length || j < 0 || j >= list.length) return next;
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

/** Names an uploaded file safely, avoiding collisions rather than overwriting. */
export function uniqueFilename(desired, existing = []) {
  const taken = new Set(existing);
  if (!taken.has(desired)) return desired;
  const dot = desired.lastIndexOf(".");
  const base = desired.slice(0, dot);
  const ext = desired.slice(dot + 1);
  for (let n = 2; n < 500; n++) {
    const candidate = `${base}-${n}.${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error("Could not find a free filename.");
}

/* ------------------------------------------------------------------ HTTP */

export function createAdmin(config) {
  const {
    sessions,
    users: rawUsers,
    githubToken,
    repo,
    branch,
    secret,
    fetchImpl = fetch,
    attempts = createAttemptLimiter()
  } = config;

  // Accounts live in the content repository, so admins can be added through
  // the web interface without anyone needing server access. ADMIN_USERS
  // remains as an environment fallback for recovery.
  const contentGh = createClient({ token: githubToken, repo, branch, fetchImpl });
  const store = createUserStore({ gh: contentGh, fallbackUsers: rawUsers });

  const html = (res, status, body) => {
    res.writeHead(status, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer"
    });
    res.end(body);
  };

  const redirect = (res, to, headers = {}) => {
    res.writeHead(302, { Location: to, "Cache-Control": "no-store", ...headers });
    res.end();
  };

  async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) throw new Error("That upload is too large.");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  function sessionFor(req) {
    const id = parseCookies(req.headers.cookie)[COOKIE];
    const session = sessions.get(id);
    return session ? { id, ...session } : null;
  }

  async function route(req, res, url) {
    // Strip a trailing slash, but never collapse "/" itself — doing so and
    // defaulting to "/admin" made the admin swallow the site's home page.
    const raw = url.pathname;
    const path = raw.length > 1 ? raw.replace(/\/+$/, "") : raw;
    if (path !== "/admin" && !path.startsWith("/admin/")) return false;

    // ---------------------------------------------------- unauthenticated
    if (path === "/admin/signin") {
      if (req.method === "GET") {
        html(res, 200, signinPage());
        return true;
      }

      if (req.method !== "POST") {
        res.setHeader("Allow", "GET, POST");
        html(res, 405, signinPage("Method not allowed."));
        return true;
      }

      const source = clientKey(req);
      if (attempts.isLocked(source)) {
        const wait = Math.ceil(attempts.retryAfter(source) / 60);
        html(res, 429, signinPage(`Too many attempts. Try again in ${wait} minute${wait === 1 ? "" : "s"}.`));
        return true;
      }

      const form = await readForm(req, readBody);
      const email = String(form.fields.email ?? "").trim().toLowerCase();
      const password = String(form.fields.password ?? "");

      const ok = await store.verify(email, password);

      if (!ok) {
        attempts.fail(source);
        html(res, 401, signinPage("That email address and password do not match."));
        return true;
      }

      attempts.succeed(source);
      const id = sessions.create({ email }, githubToken);
      redirect(res, "/admin", {
        "Set-Cookie":
          `${COOKIE}=${id}; HttpOnly; Secure; SameSite=Lax; Path=/admin; Max-Age=28800`
      });
      return true;
    }

    // Redeeming an invitation is necessarily unauthenticated: the whole
    // point is that the person does not have an account yet. The token is
    // the credential, and it is single-use and time-limited.
    if (path.startsWith("/admin/invite/")) {
      const token = path.slice("/admin/invite/".length);
      const invite = await store.findInvite(token).catch(() => null);

      if (!invite) {
        html(res, 403, layout({
          title: "Invitation",
          user: null,
          flash: { kind: "error", message: "That invitation is invalid, already used, or expired." },
          body: `<p><a href="/admin/signin">Go to sign in</a></p>`
        }));
        return true;
      }

      if (req.method === "GET") {
        html(res, 200, invitePage(token, invite.email));
        return true;
      }

      const form = await readForm(req, readBody);
      const password = String(form.fields.password ?? "");
      const confirm = String(form.fields.confirm ?? "");

      if (password !== confirm) {
        html(res, 400, invitePage(token, invite.email, "Those passwords do not match."));
        return true;
      }

      try {
        const email = await store.redeemInvite(token, password);
        const id = sessions.create({ email }, githubToken);
        redirect(res, "/admin", {
          "Set-Cookie":
            `${COOKIE}=${id}; HttpOnly; Secure; SameSite=Lax; Path=/admin; Max-Age=28800`
        });
      } catch (err) {
        html(res, 400, invitePage(token, invite.email, err.message));
      }
      return true;
    }

    // ------------------------------------------------------------- guard
    // Everything below here requires a session. Routes added after this
    // point are protected by default.
    const session = sessionFor(req);
    if (!session) {
      if (req.method === "GET") redirect(res, "/admin/signin");
      else html(res, 403, layout({ title: "Not signed in", user: null, body: "<p>Session expired.</p>" }));
      return true;
    }

    if (path === "/admin/signout") {
      sessions.destroy(session.id);
      redirect(res, "/admin/signin", {
        "Set-Cookie": `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/admin; Max-Age=0`
      });
      return true;
    }

    const gh = createClient({ token: githubToken, repo, branch, fetchImpl });
    const token = csrfToken(session.id, secret);

    if (path === "/admin/users") {
      if (req.method === "GET") {
        html(res, 200, await usersPage({ store, session, token, origin: `${url.protocol}//${url.host}` }));
        return true;
      }

      const form = await readForm(req, readBody);
      requireCsrf(session.id, form.fields.csrf, secret);

      try {
        if (form.fields.action === "revoke") {
          await store.revokeInvite(form.fields.email, session.user.email);
        } else if (form.fields.action === "remove") {
          await store.removeUser(form.fields.email, session.user.email);
        } else {
          const raw = await store.createInvite(form.fields.email, session.user.email);
          const link = `${url.protocol}//${url.host}/admin/invite/${raw}`;
          html(res, 200, await usersPage({
            store, session, token, origin: `${url.protocol}//${url.host}`,
            invited: { email: String(form.fields.email).trim().toLowerCase(), link }
          }));
          return true;
        }
        redirect(res, "/admin/users");
      } catch (err) {
        html(res, 400, await usersPage({
          store, session, token, origin: `${url.protocol}//${url.host}`, error: err.message
        }));
      }
      return true;
    }

    if (path === "/admin") {
      const rows = Object.entries(SCHEMAS)
        .map(
          ([key, schema]) =>
            `<li><a href="/admin/${escape(key)}">${escape(schema.label)}</a></li>`
        )
        .join("");
      html(
        res,
        200,
        layout({
          title: "Collections",
          user: session.user,
          body: `<h1>Collections</h1>
            <p class="a-lede">Changes are committed to <code>${escape(repo)}</code> on
            <code>${escape(branch)}</code> and go live once the deploy completes.</p>
            <ul class="a-list">${rows}</ul>
            <p class="a-admins"><a href="/admin/users">Manage admin accounts</a></p>`
        })
      );
      return true;
    }

    const parts = path.split("/").filter(Boolean); // admin, collection, ...
    const schema = getSchema(parts[1]);
    if (!schema) {
      html(res, 404, layout({ title: "Not found", user: session.user, body: "<p>No such collection.</p>" }));
      return true;
    }

    try {
      return await handleCollection({
        req, res, url, parts, schema, gh, session, token, secret, html, redirect, readBody
      });
    } catch (err) {
      const message =
        err instanceof ConflictError
          ? "Someone else saved this file first. Reload and reapply your change — nothing was overwritten."
          : err.message || "Something went wrong.";
      html(
        res,
        err instanceof ConflictError ? 409 : 500,
        layout({
          title: "Error",
          user: session.user,
          flash: { kind: "error", message },
          body: `<p><a href="/admin/${escape(parts[1])}">Back to ${escape(schema.label)}</a></p>`
        })
      );
      return true;
    }
  }

  /* ------------------------------------------------- collection handling */

  async function handleCollection(ctx) {
    const { req, res, url, parts, schema, gh, session, token, secret, html, redirect, readBody } = ctx;
    const collection = parts[1];

    const file = await gh.getFile(schema.file);
    if (!file) throw new Error(`${schema.file} could not be read from the repository.`);
    const doc = JSON.parse(file.content);

    // ---- single-object collections (site settings) ---------------------
    if (schema.kind === "object") {
      if (req.method === "GET") {
        html(res, 200, layout({
          title: schema.label,
          user: session.user,
          body: recordForm({ schema, action: `/admin/${collection}`, record: doc, token, fields: schema.fields, backTo: "/admin" })
        }));
        return true;
      }
      const form = await readForm(req, readBody);
      requireCsrf(session.id, form.fields.csrf, secret);
      const result = validateRecord(schema, form.fields);
      if (!result.ok) {
        html(res, 400, layout({
          title: schema.label,
          user: session.user,
          body: errorList(result.errors) +
            recordForm({ schema, action: `/admin/${collection}`, record: form.fields, token, fields: schema.fields, backTo: "/admin" })
        }));
        return true;
      }
      const commit = await gh.putFile({
        path: schema.file,
        content: serialise(result.value),
        message: `Update site settings via admin (${session.user.email})`,
        sha: file.sha
      });
      html(res, 200, layout({ title: "Saved", user: session.user, body: savedBody(commit, `/admin/${collection}`, schema.label) }));
      return true;
    }

    // ---- list-shaped collections ---------------------------------------
    // parts: admin, collection, [listKey], [index], [action]
    const listKey = schema.kind === "array" ? undefined : parts[2];
    const indexPart = schema.kind === "array" ? parts[2] : parts[3];
    const action = schema.kind === "array" ? parts[3] : parts[4];

    // Index page for collections that need a list chosen first.
    if (schema.kind !== "array" && listKey === undefined) {
      html(res, 200, layout({
        title: schema.label,
        user: session.user,
        body: groupIndex(schema, doc, collection)
      }));
      return true;
    }

    const list = resolveList(schema, doc, listKey);
    const fields = schema.kind === "nested" ? schema.childFields : schema.fields;
    const base = schema.kind === "array"
      ? `/admin/${collection}`
      : `/admin/${collection}/${listKey}`;

    if (req.method === "GET" && indexPart === undefined) {
      html(res, 200, layout({
        title: schema.label,
        user: session.user,
        body: listView({ schema, list, base, token, fields })
      }));
      return true;
    }

    if (req.method === "GET") {
      const record = indexPart === "new" ? {} : (list[Number(indexPart)] ?? {});
      html(res, 200, layout({
        title: schema.label,
        user: session.user,
        body: recordForm({ schema, action: `${base}/${indexPart}`, record, token, fields, backTo: base })
      }));
      return true;
    }

    // ---- mutations ------------------------------------------------------
    const form = await readForm(req, readBody);
    requireCsrf(session.id, form.fields.csrf, secret);

    let nextList;
    let message;

    if (action === "delete") {
      nextList = applyDelete(list, indexPart);
      message = `Remove ${schema.label} entry via admin (${session.user.email})`;
    } else if (action === "move") {
      nextList = applyMove(list, indexPart, form.fields.direction);
      message = `Reorder ${schema.label} via admin (${session.user.email})`;
    } else {
      const input = { ...form.fields };

      // Carry the existing image forward unless a new one was uploaded.
      for (const f of fields.filter((x) => x.type === "image")) {
        input[f.name] = form.fields[`${f.name}__current`] ?? "";
        const upload = form.files.find((file) => file.name === f.name);
        if (upload) {
          input[f.name] = await storeImage({ gh, upload, dir: f.dir, session });
        }
      }

      const result = applyEdit(schema, list, indexPart, input, fields);
      if (!result.ok) {
        html(res, 400, layout({
          title: schema.label,
          user: session.user,
          body: errorList(result.errors) +
            recordForm({ schema, action: `${base}/${indexPart}`, record: input, token, fields, backTo: base })
        }));
        return true;
      }
      nextList = result.list;
      message = `Update ${schema.label} via admin (${session.user.email})`;
    }

    const nextDoc = setList(schema, doc, listKey, nextList);
    const commit = await gh.putFile({
      path: schema.file,
      content: serialise(nextDoc),
      message,
      sha: file.sha
    });

    html(res, 200, layout({ title: "Saved", user: session.user, body: savedBody(commit, base, schema.label) }));
    return true;
  }

  async function storeImage({ gh, upload, dir, session }) {
    if (upload.data.length > MAX_IMAGE) throw new Error("Images must be 8 MB or smaller.");
    const kind = detectImageType(upload.data);
    if (!kind) throw new Error("That file is not a JPEG, PNG, WebP or SVG.");

    // Force the extension to what the bytes actually are, then slugify.
    const stem = upload.filename.replace(/\.[^.]*$/, "");
    const desired = slugifyFilename(`${stem}.${kind}`);

    const existingDir = await gh.getFile(dir).catch(() => null);
    const taken = Array.isArray(existingDir) ? existingDir.map((f) => f.name) : [];
    const name = uniqueFilename(desired, taken);

    await gh.putFile({
      path: `${dir}/${name}`,
      content: upload.data,
      message: `Upload ${name} via admin (${session.user.email})`,
      isBinary: true
    });
    return name;
  }

  /**
   * Every thrown error must still produce a response. Without this an
   * unexpected throw — a rejected CSRF check, a GitHub outage — left the
   * request open until the client gave up, with no page and no clue why.
   */
  async function handle(req, res, url) {
    try {
      return await route(req, res, url);
    } catch (err) {
      if (res.headersSent || res.writableEnded) return true;
      const isCsrf = err?.code === "CSRF";
      console.error("admin error:", err?.message ?? err);
      html(
        res,
        isCsrf ? 403 : 500,
        layout({
          title: "Something went wrong",
          user: null,
          flash: {
            kind: "error",
            message: isCsrf
              ? "That form has expired. Please reload the page and try again."
              : "Something went wrong. Nothing was saved."
          },
          body: `<p><a href="/admin">Back to the admin</a></p>`
        })
      );
      return true;
    }
  }

  return { handle };
}

/* ------------------------------------------------------------- helpers */

function clientKey(req) {
  // Behind a proxy the socket address is the proxy's, so prefer the
  // forwarded client address when one is present.
  const fwd = String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim();
  return fwd || req.socket?.remoteAddress || "unknown";
}


function invitePage(token, email, error) {
  return layout({
    title: "Set your password",
    user: null,
    flash: error ? { kind: "error", message: error } : null,
    body: `<div class="a-signin">
      <h1>Welcome to RegSymp Admin</h1>
      <p>Set a password for <strong>${escape(email)}</strong>. At least 12 characters.</p>
      <form method="post" action="/admin/invite/${escape(token)}" class="a-form a-form--signin">
        <div class="a-field">
          <label for="f-password">Password</label>
          <input id="f-password" name="password" type="password" autocomplete="new-password"
                 minlength="12" required autofocus>
        </div>
        <div class="a-field">
          <label for="f-confirm">Confirm password</label>
          <input id="f-confirm" name="confirm" type="password" autocomplete="new-password"
                 minlength="12" required>
        </div>
        <div class="a-actions"><button class="a-btn" type="submit">Create account</button></div>
      </form>
    </div>`
  });
}

async function usersPage({ store, session, token, invited, error }) {
  const users = await store.listUsers();
  const invites = await store.listInvites();

  const userRows = users
    .map((u) => `<li class="a-row">
      <span class="a-row-name">${escape(u.email)}${
        u.source === "environment" ? ' <span class="a-count">set on the server</span>' : ""
      }</span>
      ${
        u.source === "repository" && u.email !== session.user.email
          ? `<form method="post" action="/admin/users" class="a-inline"
                 onsubmit="return confirm('Remove ${escape(u.email)}?')">
               <input type="hidden" name="csrf" value="${escape(token)}">
               <input type="hidden" name="action" value="remove">
               <input type="hidden" name="email" value="${escape(u.email)}">
               <button class="a-danger">Remove</button>
             </form>`
          : '<span class="a-count">you</span>'
      }
    </li>`)
    .join("");

  const inviteRows = invites
    .map((i) => `<li class="a-row">
      <span class="a-row-name">${escape(i.email)}
        <span class="a-count">invited, not yet accepted</span></span>
      <form method="post" action="/admin/users" class="a-inline">
        <input type="hidden" name="csrf" value="${escape(token)}">
        <input type="hidden" name="action" value="revoke">
        <input type="hidden" name="email" value="${escape(i.email)}">
        <button class="a-danger">Revoke</button>
      </form>
    </li>`)
    .join("");

  const invitedBlock = invited
    ? `<div class="a-flash">
         <p>Invitation created for <strong>${escape(invited.email)}</strong>.
         Send them this link — it works once and expires in seven days.</p>
         <p><input class="a-invite-link" type="text" readonly value="${escape(invited.link)}"
                   onclick="this.select()"></p>
       </div>`
    : "";

  return layout({
    title: "Admin accounts",
    user: session.user,
    flash: error ? { kind: "error", message: error } : null,
    body: `<h1>Admin accounts</h1>
      <p class="a-lede">Anyone listed here can edit the site. Invitations are single-use
      and expire after seven days.</p>
      ${invitedBlock}
      <ul class="a-rows">${userRows}</ul>
      ${inviteRows ? `<h2 class="a-subhead">Pending invitations</h2><ul class="a-rows">${inviteRows}</ul>` : ""}
      <h2 class="a-subhead">Invite someone</h2>
      <form method="post" action="/admin/users" class="a-form">
        <input type="hidden" name="csrf" value="${escape(token)}">
        <div class="a-field">
          <label for="f-invite">Email</label>
          <input id="f-invite" name="email" type="email" required>
        </div>
        <div class="a-actions"><button class="a-btn" type="submit">Create invitation</button></div>
      </form>
      <p><a href="/admin">Back to collections</a></p>`
  });
}

function signinPage(error) {
  return layout({
    title: "Sign in",
    user: null,
    flash: error ? { kind: "error", message: error } : null,
    body: `<div class="a-signin">
      <h1>RegSymp Admin</h1>
      <p>Sign in to manage speakers, partners and the rest of the site.</p>
      <form method="post" action="/admin/signin" class="a-form a-form--signin">
        <div class="a-field">
          <label for="f-email">Email</label>
          <input id="f-email" name="email" type="email" autocomplete="username" required autofocus>
        </div>
        <div class="a-field">
          <label for="f-password">Password</label>
          <input id="f-password" name="password" type="password" autocomplete="current-password" required>
        </div>
        <div class="a-actions"><button class="a-btn" type="submit">Sign in</button></div>
      </form>
    </div>`
  });
}


function requireCsrf(sessionId, given, secret) {
  if (!verifyCsrf(sessionId, given, secret)) {
    const err = new Error("That form has expired. Please reload and try again.");
    err.code = "CSRF";
    throw err;
  }
}

async function readForm(req, readBody) {
  const raw = await readBody(req);
  const boundary = boundaryFrom(req.headers["content-type"]);
  if (boundary) return parseMultipart(raw, boundary);

  const fields = {};
  for (const [k, v] of new URLSearchParams(raw.toString("utf8"))) fields[k] = v;
  return { fields, files: [] };
}

function savedBody(commit, backTo, label) {
  const link = commit.commit.htmlUrl
    ? ` <a href="${escape(commit.commit.htmlUrl)}" target="_blank" rel="noopener">View commit</a>`
    : "";
  return `<div class="a-saved">
    <h1>Saved</h1>
    <p>Committed as <code>${escape((commit.commit.sha ?? "").slice(0, 7))}</code>.${link}</p>
    <p class="a-note">The change goes live once the deploy finishes, usually a minute or two.</p>
    <p><a class="a-btn" href="${escape(backTo)}">Back to ${escape(label)}</a></p>
  </div>`;
}

function groupIndex(schema, doc, collection) {
  if (schema.kind === "nested") {
    const rows = doc
      .map(
        (group, i) =>
          `<li><a href="/admin/${escape(collection)}/${i}">${escape(group.label)}</a>
           <span class="a-count">${(group[schema.childKey] ?? []).length}</span></li>`
      )
      .join("");
    return `<h1>${escape(schema.label)}</h1><ul class="a-list">${rows}</ul>`;
  }

  // agenda: edition -> day
  const rows = Object.entries(doc)
    .flatMap(([edition, days]) =>
      Object.keys(days).map(
        (day) =>
          `<li><a href="/admin/${escape(collection)}/${escape(edition)}.${escape(day)}">
             ${escape(edition)} — ${escape(day)}</a>
           <span class="a-count">${days[day].length}</span></li>`
      )
    )
    .join("");
  return `<h1>${escape(schema.label)}</h1><ul class="a-list">${rows}</ul>`;
}

function listView({ schema, list, base, token, fields }) {
  const nameOf = (record) => {
    const first = fields.find((f) => f.type === "text");
    return schema.identify(record) ?? record[first?.name] ?? "(untitled)";
  };

  const rows = list
    .map(
      (record, i) => `<li class="a-row">
      <a class="a-row-name" href="${escape(base)}/${i}">${escape(nameOf(record))}</a>
      <form method="post" action="${escape(base)}/${i}/move" class="a-inline">
        <input type="hidden" name="csrf" value="${escape(token)}">
        <button name="direction" value="up" aria-label="Move up">&uarr;</button>
        <button name="direction" value="down" aria-label="Move down">&darr;</button>
      </form>
      <form method="post" action="${escape(base)}/${i}/delete" class="a-inline"
            onsubmit="return confirm('Remove this entry?')">
        <input type="hidden" name="csrf" value="${escape(token)}">
        <button class="a-danger">Remove</button>
      </form>
    </li>`
    )
    .join("");

  return `<h1>${escape(schema.label)}</h1>
    <p><a class="a-btn" href="${escape(base)}/new">Add new</a></p>
    <ul class="a-rows">${rows}</ul>`;
}

function recordForm({ schema, action, record, token, fields, backTo }) {
  const controls = fields.map((f) => field(f, record[f.name] ?? "")).join("");
  const hasImage = fields.some((f) => f.type === "image");
  return `<form method="post" action="${escape(action)}"
      ${hasImage ? 'enctype="multipart/form-data"' : ""} class="a-form">
    <input type="hidden" name="csrf" value="${escape(token)}">
    ${controls}
    <div class="a-actions">
      <button class="a-btn" type="submit">Save</button>
      <a class="a-cancel" href="${escape(backTo)}">Cancel</a>
    </div>
  </form>`;
}
