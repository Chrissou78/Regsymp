import { randomBytes } from "node:crypto";
import { SCHEMAS, getSchema, validateRecord } from "./schemas.js";
import { ConflictError } from "./conflict.js";
import { csrfToken, parseCookies, verifyCsrf } from "./auth.js";
import { createAttemptLimiter } from "./login-attempts.js";
import { configValue } from "./runtime-config.js";
import { escape, errorList, field, layout } from "./render.js";
import { attendeesPage, importPreviewPage } from "./attendees-page.js";
import { badgeSheetPage, categoriesPage } from "./badges-page.js";
import QRCode from "qrcode";
import { parseAttendees } from "./import-attendees.js";
import { boundaryFrom, detectImageType, parseMultipart } from "./multipart.js";
import { slugifyFilename } from "./sanitise.js";

const COOKIE = "regsymp_admin";
const MAX_BODY = 12 * 1024 * 1024;
const MAX_IMAGE = 8 * 1024 * 1024;

// Images pinned per click. Bounded so a request cannot outlive a proxy.
const BATCH = 20;

const BY_EXTENSION = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  avif: "image/avif",
  gif: "image/gif",
  svg: "image/svg+xml"
};

const BY_SNIFF = { jpg: "image/jpeg", png: "image/png", webp: "image/webp", svg: "image/svg+xml" };

/**
 * What these bytes actually are, preferring the bytes over the filename.
 *
 * Two logos in this repository are JPEGs named `.svg`. Served as
 * `image/svg+xml` a browser refuses to draw them, which is exactly how the
 * broken thumbnail turned up. The extension is a hint; the magic bytes are
 * the answer.
 */
function mimeFor(path, bytes) {
  const sniffed = bytes ? detectImageType(bytes) : null;
  if (sniffed && BY_SNIFF[sniffed]) return BY_SNIFF[sniffed];
  return BY_EXTENSION[String(path).split(".").pop()?.toLowerCase()] ?? "application/octet-stream";
}

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
    store,
    userStore,
    secret,
    // Service credentials, when there is a database to hold them. Injected
    // rather than imported so the routes stay unaware of the storage.
    credentials = null,
    // IPFS pinning, likewise injected.
    ipfs = null,
    // The guest list. Present only when there is a database to hold it.
    guests = null,
    // Why the store cannot be reached, if it cannot. Reported rather than
    // left to surface as an opaque failure on whatever page is opened first.
    unavailable = () => null,
    // Returns a warning to show above the collections, or null. Used to say
    // out loud when the content directory is not actually persistent: edits
    // would appear to work and then vanish on the next deploy.
    warning = () => null,
    attempts = createAttemptLimiter()
  } = config;

  const secret$ = () => secret || configValue("SESSION_SECRET");

  // Injected, so the admin works the same whether accounts are rows in
  // Postgres or a document in the content store.
  const storeFor = () => userStore;

  /** Is there anywhere to save to? */
  function writable() {
    return Boolean(store);
  }

  /**
   * How many accounts exist, counting the environment fallback.
   * Zero means this is a fresh installation and needs its first account.
   */
  async function accountCount() {
    try {
      return (await storeFor().listUsers()).length;
    } catch {
      // Unreadable is not the same as empty: do not offer to claim an admin
      // that might already have owners.
      return 1;
    }
  }

  const html = (res, status, body) => {
    res.writeHead(status, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer"
    });
    res.end(body);
  };

  const binary = (res, bytes, { type, filename = null, cache = "private, max-age=300" }) => {
    res.writeHead(200, {
      "Content-Type": type,
      "Content-Length": String(bytes.length),
      "Cache-Control": cache,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      ...(filename
        ? { "Content-Disposition": `attachment; filename="${filename.replace(/[^\w.\-]/g, "_")}"` }
        : {})
    });
    res.end(bytes);
  };

  const redirect = (res, to, headers = {}) => {
    res.writeHead(302, { Location: to, "Cache-Control": "no-store", ...headers });
    res.end();
  };

  const notWritable = (res) => {
    html(res, 503, layout({
      title: "No content store",
      user: null,
      flash: { kind: "error", message: "The admin has nowhere to save to." },
      body: `<p>The content directory is not available, so nothing can be read or
             written. Check that the volume is mounted and that
             <code>CONTENT_DIR</code> points at it.</p>`
    }));
    return true;
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

  /**
   * Rewrite the readable hint cookie with one role removed.
   *
   * The hint lives in the browser and the session lives on the server, so they
   * can disagree — most obviously after a restart, when the menu offered a
   * link that immediately bounced to sign in. Whenever a surface turns an
   * unauthenticated request away, it takes its own role out of the hint so the
   * menu stops claiming it.
   */
  function dropRole(req, role) {
    const raw = parseCookies(req.headers.cookie).regsymp_who ?? "";
    const roles = decodeURIComponent(raw).split("-").filter(Boolean).filter((r) => r !== role);
    return roles.length
      ? `regsymp_who=${roles.join("-")}; Secure; SameSite=Lax; Path=/; Max-Age=${8 * 60 * 60}`
      : "regsymp_who=; Secure; SameSite=Lax; Path=/; Max-Age=0";
  }

  async function sessionFor(req) {
    const id = parseCookies(req.headers.cookie)[COOKIE];
    const session = await sessions.get(id);
    return session ? { id, ...session } : null;
  }

  async function route(req, res, url) {
    // Strip a trailing slash, but never collapse "/" itself — doing so and
    // defaulting to "/admin" made the admin swallow the site's home page.
    const raw = url.pathname;
    const path = raw.length > 1 ? raw.replace(/\/+$/, "") : raw;
    if (path !== "/admin" && !path.startsWith("/admin/")) return false;

    // ----------------------------------------------------------- first run
    // With content on a volume there is nothing to configure — no token, no
    // secret — so the only thing a new installation still needs is its first
    // account. This route creates it, and exists only while there are none.
    if (path === "/admin/first-run") {
      if (!writable()) return notWritable(res);

      if ((await accountCount()) > 0) {
        html(res, 404, layout({
          title: "Not found",
          user: null,
          body: `<p>This admin already has an account.</p>
                 <p><a href="/admin/signin">Go to sign in</a></p>`
        }));
        return true;
      }

      if (req.method === "GET") {
        html(res, 200, firstRunPage());
        return true;
      }

      const form = await readForm(req, readBody);
      const email = String(form.fields.email ?? "").trim().toLowerCase();
      const password = String(form.fields.password ?? "");
      if (password !== String(form.fields.confirm ?? "")) {
        html(res, 400, firstRunPage("Those passwords do not match.", email));
        return true;
      }

      try {
        await storeFor().createUser(email, password, "first run");
      } catch (err) {
        html(res, 400, firstRunPage(err.message, email));
        return true;
      }

      html(res, 200, layout({
        title: "Account created",
        user: null,
        flash: { kind: "ok", message: `${escape(email)} is now the owner.` },
        body: `<p><a class="a-btn" href="/admin/signin">Sign in</a></p>`
      }));
      return true;
    }

    // Send a brand-new installation somewhere useful rather than to a sign-in
    // form that no account can satisfy.
    if (writable() && (await accountCount()) === 0) {
      redirect(res, "/admin/first-run");
      return true;
    }

    // Nothing works without somewhere to save to.
    if (!writable()) return notWritable(res);

    // Configured, but not reachable. Saying so beats every page failing with
    // "something went wrong" and no indication of what or why.
    const outage = unavailable();
    if (outage) {
      html(res, 503, layout({
        title: "Database unavailable",
        user: null,
        flash: { kind: "error", message: "The admin cannot reach the database." },
        body: `<p>The site itself is unaffected and is serving normally. Nothing
               can be read or saved here until the connection is restored.</p>
               <p class="a-note">${escape(outage)}</p>`
      }));
      return true;
    }

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

      const ok = await storeFor().verify(email, password);

      if (!ok) {
        attempts.fail(source);
        html(res, 401, signinPage("That email address and password do not match."));
        return true;
      }

      attempts.succeed(source);
      const id = await sessions.create({ email }, null);
      redirect(res, "/admin", {
        "Set-Cookie":
          `${COOKIE}=${id}; HttpOnly; Secure; SameSite=Lax; Path=/admin; Max-Age=28800`
      });
      return true;
    }

    // Redeeming an invitation is necessarily unauthenticated: the whole
    // point is that the person does not have an account yet. The token is
    // the credential, and it is single-use and time-limited.
    // ------------------------------------------------------------- guard
    // Everything below here requires a session. Routes added after this
    // point are protected by default.
    const session = await sessionFor(req);
    if (!session) {
      // Take "admin" out of the readable hint on the way past, so the menu
      // stops offering a link that lands here.
      const correct = { "Set-Cookie": dropRole(req, "admin") };
      if (req.method === "GET") redirect(res, "/admin/signin", correct);
      else {
        res.writeHead(403, { "Content-Type": "text/html; charset=utf-8", ...correct });
        res.end(layout({ title: "Not signed in", user: null, body: "<p>Session expired.</p>" }));
      }
      return true;
    }

    if (path === "/admin/signout") {
      await sessions.destroy(session.id);
      redirect(res, "/admin/signin", {
        "Set-Cookie": `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/admin; Max-Age=0`
      });
      return true;
    }

    const gh = store;
    const token = csrfToken(session.id, secret$());

    if (path === "/admin/account") {
      if (req.method === "GET") {
        html(res, 200, accountPage({ session, token }));
        return true;
      }

      const form = await readForm(req, readBody);
      requireCsrf(session.id, form.fields.csrf, secret$());

      const current = String(form.fields.currentPassword ?? "");
      const next = String(form.fields.newPassword ?? "");
      const confirm = String(form.fields.confirmPassword ?? "");

      if (next !== confirm) {
        html(res, 400, accountPage({ session, token, error: "Those passwords do not match." }));
        return true;
      }

      try {
        await storeFor().changePassword(session.user.email, current, next);
      } catch (err) {
        html(res, 400, accountPage({ session, token, error: err.message }));
        return true;
      }

      // If the password was changed because it was compromised, leaving the
      // other sessions signed in would defeat the purpose.
      const endedElsewhere = (await sessions.destroyOthersFor?.(session.user.email, session.id)) ?? 0;

      html(res, 200, layout({
        title: "Password changed",
        user: session.user,
        flash: { kind: "ok", message: "Your password has been changed." },
        body: `<p>Use the new password next time you sign in.${
          endedElsewhere > 0
            ? ` Any other session for this account has been signed out.`
            : ""
        }</p>
        <p><a class="a-btn" href="/admin">Back to collections</a></p>`
      }));
      return true;
    }

    // ------------------------------------------------------------- badges
    if (path === "/admin/badges" || path.startsWith("/admin/badges/")) {
      if (!guests) {
        html(res, 404, layout({ title: "Not found", user: session.user, body: "<p>Badges need a database.</p>" }));
        return true;
      }

      const one = path.startsWith("/admin/badges/") ? path.slice("/admin/badges/".length) : null;
      const wanted = url.searchParams.get("category");
      const everyone = await guests.list({ limit: 1000 });

      const holders = everyone.filter(
        (g) => g.ticket && (!wanted || g.ticket.category === wanted) && (!one || g.ticket.code === one)
      );

      // The QR is the same one the ticket page shows, so a single scan works
      // for a badge, a phone, or a wallet pass.
      const origin = originFor(req);
      const badges = [];
      for (const guest of holders) {
        const ticket = await guests.ticketFor(guest.id);
        if (!ticket) continue;
        badges.push({
          guest,
          ticket,
          qr: await QRCode.toString(`${origin}/t/${ticket.code}`, {
            type: "svg",
            errorCorrectionLevel: "M",
            margin: 0,
            width: 150
          })
        });
      }

      html(res, 200, badgeSheetPage({
        badges,
        session,
        filter: wanted,
        categories: await guests.categories()
      }));
      return true;
    }

    // -------------------------------------------------------- categories
    if (path === "/admin/categories") {
      if (!guests) {
        html(res, 404, layout({ title: "Not found", user: session.user, body: "<p>Categories need a database.</p>" }));
        return true;
      }

      const show = async (flash = null) =>
        categoriesPage({ categories: await guests.categories(), session, token, flash });

      if (req.method === "GET") {
        html(res, 200, await show());
        return true;
      }

      const form = await readForm(req, readBody);
      requireCsrf(session.id, form.fields.csrf, secret$());
      const fields = {
        slug: form.fields.slug,
        label: form.fields.label,
        from: form.fields.from,
        to: form.fields.to,
        colour: form.fields.colour,
        sort: form.fields.sort
      };

      try {
        let message;
        if (form.fields.action === "remove") {
          await guests.removeCategory(form.fields.slug);
          message = `${form.fields.slug} removed.`;
        } else if (form.fields.action === "edit") {
          const saved = await guests.editCategory(form.fields.slug, fields);
          message = `${saved.label} saved.`;
        } else {
          const created = await guests.addCategory(fields);
          message = `${created.label} added${
            created.numbered ? ` with numbers ${created.from}–${created.to}` : " (unnumbered)"
          }.`;
        }
        html(res, 200, await show({ kind: "ok", message }));
      } catch (err) {
        html(res, 400, await show({ kind: "error", message: err.message }));
      }
      return true;
    }

    if (path === "/admin/attendees") {
      if (!guests) {
        html(res, 404, layout({
          title: "Not found",
          user: session.user,
          body: `<p>The guest list needs a database.</p>
                 <p><a href="/admin">Back to collections</a></p>`
        }));
        return true;
      }

      const render = async (flash = null, q = "") =>
        attendeesPage({
          guests: await guests.list({ q: q || null }),
          capacity: await guests.capacity(),
          categories: await guests.categories(),
          speakerSlugs: await guests.speakerSlugs(),
          session,
          token,
          flash,
          q
        });

      if (req.method === "GET") {
        html(res, 200, await render(null, url.searchParams.get("q") ?? ""));
        return true;
      }

      const form = await readForm(req, readBody);
      requireCsrf(session.id, form.fields.csrf, secret$());
      const by = session.user.email;
      const id = form.fields.id;
      const origin = originFor(req);

      try {
        let message = "";
        switch (form.fields.action) {
          case "create": {
            const created = await guests.create(
              {
                email: form.fields.email,
                firstName: form.fields.firstName,
                lastName: form.fields.lastName,
                company: form.fields.company,
                role: form.fields.role || "visitor"
              },
              by
            );
            message = `${created.email} added.`;
            if (form.fields.sendClaim === "yes") {
              const sent = await guests.sendClaim(created.id, origin);
              message += sent ? " A set-password link is on its way." : " Email is not configured, so no link was sent.";
            }
            break;
          }
          case "importPreview": {
            const paste = String(form.fields.paste ?? "");
            const parsed = parseAttendees(paste);
            if (!parsed.rows.length && !parsed.problems.length) {
              html(res, 400, await render({ kind: "error", message: "There was nothing to read in that paste." }));
              return true;
            }
            html(res, 200, importPreviewPage({
              parsed,
              existing: await guests.list({ limit: 1000 }),
              role: form.fields.role === "speaker" ? "speaker" : "visitor",
              sendClaim: form.fields.sendClaim === "yes",
              paste,
              session,
              token
            }));
            return true;
          }
          case "importConfirm": {
            // Re-parsed from the same text rather than trusting a list of
            // records round-tripped through the browser: the preview is a
            // check for the person, not a source of truth for the server.
            const parsed = parseAttendees(String(form.fields.paste ?? ""));
            const role = form.fields.role === "speaker" ? "speaker" : "visitor";
            const notify = form.fields.sendClaim === "yes";

            let added = 0;
            let skipped = 0;
            const failures = [];

            for (const record of parsed.rows) {
              try {
                const created = await guests.create({ ...record, role }, by);
                added += 1;
                if (notify) {
                  await guests.sendClaim(created.id, origin).catch((err) =>
                    failures.push(`${record.email}: could not email (${err.message})`)
                  );
                }
              } catch (err) {
                if (/already registered/i.test(err.message)) skipped += 1;
                else failures.push(`${record.email}: ${err.message}`);
              }
            }

            message =
              `${added} added` +
              (skipped ? `, ${skipped} already registered` : "") +
              (parsed.problems.length ? `, ${parsed.problems.length} unreadable line(s)` : "") +
              (failures.length ? `. Problems: ${failures.slice(0, 3).join("; ")}` : ".");
            break;
          }
          case "issue": {
            const areas = String(form.fields.areas ?? "")
              .split(",")
              .map((a) => a.trim())
              .filter(Boolean);
            const ticket = await guests.issueTicket({
              attendeeId: id,
              category: form.fields.category,
              issuedBy: by,
              areas
            });
            message = ticket.number
              ? `Badge #${ticket.number} issued.`
              : "Badge issued (unnumbered).";
            break;
          }
          case "revoke":
            await guests.revoke(id);
            message =
              "Badge withdrawn. Its number is not reissued — a printed badge " +
              "carrying it may still be in circulation.";
            break;
          case "sendClaim":
            message = (await guests.sendClaim(id, origin))
              ? "A set-password link is on its way."
              : "Email is not configured, so no link was sent.";
            break;
          case "sendVerify":
            message = (await guests.sendVerify(id, origin))
              ? "A confirmation link is on its way."
              : "Email is not configured, so no link was sent.";
            break;
          case "linkSpeaker":
            await guests.linkSpeaker(id, form.fields.speakerSlug || null);
            message = form.fields.speakerSlug
              ? "Linked to the public speaker entry. Their edits will update the site."
              : "Unlinked from the public speaker entry.";
            break;
          default:
            message = "Nothing to do.";
        }
        html(res, 200, await render({ kind: "ok", message }));
      } catch (err) {
        html(res, 400, await render({ kind: "error", message: err.message }));
      }
      return true;
    }

    // A thumbnail of the stored copy: no gateway, no decryption, because a
    // page showing eighty of them should not need eighty round trips.
    if (path.startsWith("/admin/ipfs/thumb/") && ipfs) {
      const found = await ipfs.thumbnail(path.slice("/admin/ipfs/thumb/".length));
      if (!found) {
        html(res, 404, layout({ title: "Not found", user: session.user, body: "<p>No such image.</p>" }));
        return true;
      }
      binary(res, found.bytes, { type: mimeFor(found.path, found.bytes) });
      return true;
    }

    // The pinned copy, fetched back and decrypted. Downloading what is
    // actually on IPFS is the only thing that proves the encrypted backup is
    // intact and the key still opens it.
    if (path.startsWith("/admin/ipfs/original/") && ipfs) {
      let found;
      try {
        found = await ipfs.original(path.slice("/admin/ipfs/original/".length));
      } catch (err) {
        html(res, 502, layout({
          title: "Could not fetch it back",
          user: session.user,
          flash: { kind: "error", message: err.message },
          body: `<p>The pinned copy could not be retrieved or decrypted.</p>
                 <p><a href="/admin/ipfs">Back to IPFS</a></p>`
        }));
        return true;
      }
      if (!found) {
        html(res, 404, layout({ title: "Not found", user: session.user, body: "<p>No such image.</p>" }));
        return true;
      }
      binary(res, found.bytes, {
        type: mimeFor(found.path, found.bytes),
        filename: found.path.split("/").pop(),
        cache: "no-store"
      });
      return true;
    }

    if (path === "/admin/ipfs") {
      if (!ipfs) {
        html(res, 404, layout({
          title: "Not found",
          user: session.user,
          body: `<p>Pinning needs a database to record the CIDs in.</p>
                 <p><a href="/admin">Back to collections</a></p>`
        }));
        return true;
      }

      if (req.method === "GET") {
        html(res, 200, await ipfsPage({ ipfs, session, token }));
        return true;
      }

      // Viewing is open to any admin; spending uploads is the owner's call.
      if (!(await storeFor().isOwner(session.user.email))) {
        html(res, 403, layout({
          title: "Not permitted",
          user: session.user,
          flash: { kind: "error", message: "Only the account owner can start pinning." },
          body: `<p><a href="/admin/ipfs">Back to IPFS</a></p>`
        }));
        return true;
      }

      const form = await readForm(req, readBody);
      requireCsrf(session.id, form.fields.csrf, secret$());

      // A bounded batch per click. Pinning every image on the site takes
      // longer than a request should, and a proxy timing out halfway through
      // tells the person nothing about what actually got pinned.
      const result = await ipfs.backfill(BATCH);
      html(res, 200, await ipfsPage({ ipfs, session, token, result }));
      return true;
    }

    if (path === "/admin/credentials") {
      // Only meaningful with a database. Without one the credentials are in
      // the host environment and this page could not change them.
      if (!credentials) {
        html(res, 404, layout({
          title: "Not found",
          user: session.user,
          body: `<p>Credentials are held in the host environment on this deployment.</p>
                 <p><a href="/admin">Back to collections</a></p>`
        }));
        return true;
      }

      if (!(await storeFor().isOwner(session.user.email))) {
        html(res, 403, layout({
          title: "Not permitted",
          user: session.user,
          flash: { kind: "error", message: "Only the account owner can manage credentials." },
          body: `<p><a href="/admin">Back to collections</a></p>`
        }));
        return true;
      }

      if (req.method === "GET") {
        html(res, 200, await credentialsPage({ credentials, session, token }));
        return true;
      }

      const form = await readForm(req, readBody);
      requireCsrf(session.id, form.fields.csrf, secret$());

      try {
        if (form.fields.action === "reveal") {
          const name = String(form.fields.name ?? "");
          if (!(credentials.escrowable ?? []).includes(name)) {
            throw new Error(`${name} cannot be displayed.`);
          }
          html(res, 200, await credentialsPage({
            credentials, session, token, revealed: { name, value: credentials.reveal(name) }
          }));
          return true;
        }
        if (form.fields.action === "clear") {
          await credentials.clear(form.fields.name);
        } else {
          await credentials.set(
            form.fields.name,
            String(form.fields.value ?? ""),
            session.user.email
          );
        }
        redirect(res, "/admin/credentials");
      } catch (err) {
        html(res, 400, await credentialsPage({
          credentials, session, token, error: err.message
        }));
      }
      return true;
    }

    if (path === "/admin/users") {
      // Account management is the owner's alone. Checked here rather than
      // only hiding the link, so knowing the URL is not enough.
      if (!(await storeFor().isOwner(session.user.email))) {
        html(res, 403, layout({
          title: "Not permitted",
          user: session.user,
          flash: { kind: "error", message: "Only the account owner can manage admins." },
          body: `<p><a href="/admin">Back to collections</a></p>`
        }));
        return true;
      }

      if (req.method === "GET") {
        html(res, 200, await usersPage({ store: storeFor(), session, token, origin: originFor(req) }));
        return true;
      }

      const form = await readForm(req, readBody);
      requireCsrf(session.id, form.fields.csrf, secret$());

      try {
        if (form.fields.action === "remove") {
          await storeFor().removeUser(form.fields.email, session.user.email);
        } else if (form.fields.action === "create") {
          const created = await storeFor().createUser(
            form.fields.email,
            String(form.fields.password ?? ""),
            session.user.email
          );
          html(res, 200, await usersPage({
            store: storeFor(), session, token, origin: originFor(req),
            created
          }));
          return true;
        }
        redirect(res, "/admin/users");
      } catch (err) {
        html(res, 400, await usersPage({
          store: storeFor(), session, token, origin: originFor(req), error: err.message
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
      const owner = await storeFor().isOwner(session.user.email);
      const warn = await warning();
      html(
        res,
        200,
        layout({
          title: "Collections",
          user: session.user,
          body: `<h1>Collections</h1>
            ${warn ? `<p class="a-warning"><strong>Changes here are temporary.</strong> ${escape(warn)}</p>` : ""}
            <p class="a-lede">Changes are saved to the content volume and rebuilt
            immediately &mdash; no deploy, and nothing signs you out.</p>
            <ul class="a-list">${rows}</ul>
            <p class="a-admins">${owner ? '<a href="/admin/users">Manage admin accounts</a> &nbsp;·&nbsp; ' : ""}${owner && credentials ? '<a href="/admin/credentials">Service credentials</a> &nbsp;·&nbsp; ' : ""}${guests ? '<a href="/admin/attendees">Guest list</a> &nbsp;·&nbsp; <a href="/admin/badges">Badges</a> &nbsp;·&nbsp; ' : ""}${ipfs ? '<a href="/admin/ipfs">IPFS</a> &nbsp;·&nbsp; ' : ""}<a href="/admin/account">Change your password</a></p>`
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
      requireCsrf(session.id, form.fields.csrf, secret$());
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

    // ---- managing the groups themselves (partner tiers) ------------------
    // Addressed under /tier/ so it cannot collide with /admin/partners/0,
    // which addresses the logos *inside* tier 0.
    if (schema.kind === "nested" && parts[2] === "tier") {
      const tierIndex = parts[3];
      const tierAction = parts[4];
      const groups = Array.isArray(doc) ? doc : [];
      const groupBase = `/admin/${collection}`;

      if (req.method === "GET") {
        const record = tierIndex === "new" ? {} : (groups[Number(tierIndex)] ?? {});
        html(res, 200, layout({
          title: schema.label,
          user: session.user,
          body: recordForm({
            schema,
            action: `${groupBase}/tier/${tierIndex}`,
            record,
            token,
            fields: schema.fields,
            backTo: groupBase
          })
        }));
        return true;
      }

      const tierForm = await readForm(req, readBody);
      requireCsrf(session.id, tierForm.fields.csrf, secret$());

      let nextGroups;
      let tierMessage;

      if (tierAction === "delete") {
        const target = groups[Number(tierIndex)];
        if ((target?.[schema.childKey] ?? []).length > 0) {
          html(res, 400, layout({
            title: schema.label,
            user: session.user,
            flash: {
              kind: "error",
              message: `Remove the logos from "${target.label}" before deleting the group.`
            },
            body: `<p><a href="${escape(groupBase)}">Back to ${escape(schema.label)}</a></p>`
          }));
          return true;
        }
        nextGroups = applyDelete(groups, tierIndex);
        tierMessage = `Remove ${schema.label} group via admin (${session.user.email})`;
      } else if (tierAction === "move") {
        nextGroups = applyMove(groups, tierIndex, tierForm.fields.direction);
        tierMessage = `Reorder ${schema.label} groups via admin (${session.user.email})`;
      } else {
        const result = applyEdit(schema, groups, tierIndex, tierForm.fields, schema.fields);
        if (!result.ok) {
          html(res, 400, layout({
            title: schema.label,
            user: session.user,
            body:
              errorList(result.errors) +
              recordForm({
                schema,
                action: `${groupBase}/tier/${tierIndex}`,
                record: tierForm.fields,
                token,
                fields: schema.fields,
                backTo: groupBase
              })
          }));
          return true;
        }
        // A new group starts with an empty child list so the shape stays valid.
        nextGroups = result.list.map((g, i) =>
          i === result.list.length - 1 && tierIndex === "new"
            ? { ...g, [schema.childKey]: [] }
            : g
        );
        tierMessage = `Update ${schema.label} group via admin (${session.user.email})`;
      }

      const commit = await gh.putFile({
        path: schema.file,
        content: serialise(nextGroups),
        message: tierMessage,
        sha: file.sha
      });
      html(res, 200, layout({
        title: "Saved",
        user: session.user,
        body: savedBody(commit, groupBase, schema.label)
      }));
      return true;
    }

    // Index page for collections that need a list chosen first.
    if (schema.kind !== "array" && listKey === undefined) {
      html(res, 200, layout({
        title: schema.label,
        user: session.user,
        body: groupIndex(schema, doc, collection, token)
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
    requireCsrf(session.id, form.fields.csrf, secret$());

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

  /**
   * Mint an admin session for an address already proven to be an admin.
   *
   * Used by the single sign-in form on the site, so there is one place to log
   * in rather than a URL to remember. Deliberately does not verify anything:
   * the caller must have checked the password against admin_users first, and
   * the two credential stores stay separate — this only issues the cookie.
   */
  async function issueSession(email) {
    const id = await sessions.create({ email: String(email).trim().toLowerCase() }, null);
    return `${COOKIE}=${id}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${8 * 60 * 60}`;
  }

  return { handle, issueSession };
}

/* ------------------------------------------------------------- helpers */


/**
 * The public origin of a request.
 *
 * server.js parses the request URL against a fixed "http://localhost" base,
 * which is fine for reading the path but makes url.host useless for building
 * links — invitation links came out pointing at localhost. The real host is
 * in the headers, and behind a proxy the scheme is only in x-forwarded-proto.
 */
export function originFor(req) {
  const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "")
    .split(",")[0]
    .trim();
  if (!host) return "";

  const forwarded = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim();
  const isLocal = /^(localhost|127\.|\[::1\])/.test(host);
  // A proxy tells us the scheme; failing that, anything not local is public
  // and therefore HTTPS. Defaulting to http would hand out insecure links.
  const proto = forwarded || (req.socket?.encrypted ? "https" : isLocal ? "http" : "https");

  return `${proto}://${host}`;
}


function clientKey(req) {
  // Behind a proxy the socket address is the proxy's, so prefer the
  // forwarded client address when one is present.
  const fwd = String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim();
  return fwd || req.socket?.remoteAddress || "unknown";
}


/**
 * Service credentials.
 *
 * Stored values are never rendered — only whether each is set, and where it
 * came from. A page that echoes a credential back is a page that leaks one to
 * anybody who gets a session, a screenshot, or a browser cache.
 */
/**
 * Which images are on IPFS.
 *
 * Pinning is best-effort, so "not pinned" needs disambiguating: not attempted
 * yet, or attempted and failed. Nobody administering this can read a log, so
 * the reason and the attempt count are on the page.
 */
async function ipfsPage({ ipfs, session, token, result }) {
  const [status, auth] = await Promise.all([ipfs.status(), ipfs.testAuth()]);
  const owner = true; // the route has already checked for write actions

  const rows = (await ipfs.list())
    .slice(0, 300)
    .map((pin) => {
      const name = pin.path.replace(/^src\/assets\/images\//, "");
      return `<li class="a-pin">
        <a class="a-pin-thumb" href="/admin/ipfs/original/${escape(pin.digest)}"
           title="Fetch from IPFS, decrypt, and download">
          <img src="/admin/ipfs/thumb/${escape(pin.digest)}" alt="${escape(name)}"
               loading="lazy" width="72" height="72">
        </a>
        <div class="a-pin-body">
          <span class="a-pin-name">${escape(name)}</span>
          <span class="a-pin-meta">
            ${pin.encrypted ? "&#128274; encrypted" : "unencrypted"} &middot;
            ${Math.max(1, Math.round(pin.bytes / 1024))} KB
          </span>
          <span class="a-pin-links">
            <a href="/admin/ipfs/original/${escape(pin.digest)}">Download decrypted</a>
            <a href="${escape(ipfs.gatewayUrl(pin.cid))}" target="_blank" rel="noopener"
               title="The raw pinned bytes, which are ciphertext">${escape(pin.cid.slice(0, 10))}&hellip;</a>
          </span>
        </div>
      </li>`;
    })
    .join("");

  const failures = status.failures.length
    ? `<h2>Not pinned</h2><ul class="a-list">${status.failures
        .map((f) => `<li class="a-row a-row--stack">
             <span class="a-row-name">${escape((f.path ?? "").split("/").pop())}</span>
             <p class="a-note">${escape(f.error)} &middot; ${f.attempts} attempt${
               f.attempts === 1 ? "" : "s"
             }</p>
           </li>`)
        .join("")}</ul>`
    : "";

  const remaining = status.unpinned + status.plaintext;
  const summary = result
    ? `<div class="a-flash"><p>Processed ${result.pinned ?? 0}${
        result.failed ? `, ${result.failed} failed` : ""
      }.${remaining > 0 ? ` ${remaining} still to go — run it again.` : " All done."}</p></div>`
    : "";

  return layout({
    title: "IPFS",
    user: session.user,
    flash: auth.ok
      ? null
      : { kind: "error", message: `Pinata is not usable: ${auth.reason ?? "unknown"}` },
    body: `<h1>IPFS</h1>
      <p class="a-lede">Originals are pinned to IPFS as the record, encrypted
      before they leave the server. The site keeps serving its own optimised
      versions, so pages stay fast and no page load depends on a gateway.</p>
      <p class="a-note">A gateway link returns ciphertext, not a picture &mdash;
      that is the point. Decrypting needs the key in
      <a href="/admin/credentials">service credentials</a>, so keep a copy of it
      somewhere else: without it these copies are unreadable.</p>
      ${summary}
      <ul class="a-list">
        <li class="a-row"><span class="a-row-name">Images</span><span class="a-count">${status.images}</span></li>
        <li class="a-row"><span class="a-row-name">Pinned, encrypted</span><span class="a-count">${status.encrypted}</span></li>
        <li class="a-row"><span class="a-row-name">Pinned in the clear</span><span class="a-count">${status.plaintext}</span></li>
        <li class="a-row"><span class="a-row-name">Not pinned</span><span class="a-count">${status.unpinned}</span></li>
      </ul>
      ${
        status.plaintext > 0
          ? `<p class="a-warning">${status.plaintext} image${status.plaintext === 1 ? " is" : "s are"}
             pinned unencrypted. Running the button below re-pins ${
               status.plaintext === 1 ? "it" : "them"
             } encrypted and removes the plain copy from the service &mdash; though
             anything already fetched by someone else cannot be recalled.</p>`
          : ""
      }
      ${
        (status.unpinned > 0 || status.plaintext > 0) && auth.ok
          ? `<form method="post" action="/admin/ipfs">
               <input type="hidden" name="csrf" value="${escape(token)}">
               <button class="a-btn">Process the next ${Math.min(
                 status.unpinned + status.plaintext,
                 20
               )}</button>
             </form>`
          : ""
      }
      ${failures}
      ${
        rows
          ? `<h2>On IPFS</h2>
             <p class="a-note">Thumbnails come from the database. "Download
             decrypted" fetches the copy actually pinned on IPFS and decrypts
             it, which is the only thing that proves the backup is intact and
             the key still opens it.</p>
             <ul class="a-pins">${rows}</ul>`
          : ""
      }
      <p><a class="a-btn" href="/admin">Back to collections</a></p>`
  });
}

async function credentialsPage({ credentials, session, token, error, revealed }) {
  const entries = await credentials.list();

  const rows = entries
    .map((entry) => {
      const escrowable = (credentials.escrowable ?? []).includes(entry.name);
      const hidden = `<input type="hidden" name="csrf" value="${escape(token)}">
        <input type="hidden" name="name" value="${escape(entry.name)}">`;

      return `<li class="a-cred">
        <div class="a-cred-top">
          <code class="a-cred-name">${escape(entry.name)}</code>
          <span class="a-cred-state a-cred-state--${entry.set ? "set" : "unset"}">${
            entry.set ? `set &middot; ${escape(entry.source ?? "")}` : "not set"
          }</span>
        </div>

        ${entry.help ? `<p class="a-cred-help">${escape(entry.help)}</p>` : ""}

        ${
          entry.updatedAt
            ? `<p class="a-cred-meta">Last changed ${escape(
                new Date(entry.updatedAt).toISOString().slice(0, 16).replace("T", " ")
              )}${entry.updatedBy ? ` by ${escape(entry.updatedBy)}` : ""}</p>`
            : ""
        }

        <div class="a-cred-actions">
          <form method="post" action="/admin/credentials" class="a-cred-set">
            ${hidden}
            <input name="value" type="password" autocomplete="off" spellcheck="false"
                   placeholder="${entry.set ? "Replace this value" : "Paste the value"}"
                   aria-label="New value for ${escape(entry.name)}" required>
            <button class="a-btn">Save</button>
          </form>

          ${
            escrowable && entry.set
              ? `<form method="post" action="/admin/credentials" class="a-cred-aside">
                   ${hidden}<input type="hidden" name="action" value="reveal">
                   <button>Show once</button>
                 </form>`
              : ""
          }
          ${
            entry.source === "database"
              ? `<form method="post" action="/admin/credentials" class="a-cred-aside"
                       onsubmit="return confirm('Clear ${escape(entry.name)}?')">
                   ${hidden}<input type="hidden" name="action" value="clear">
                   <button class="a-danger">Clear</button>
                 </form>`
              : ""
          }
        </div>
      </li>`;
    })
    .join("");

  return layout({
    title: "Service credentials",
    user: session.user,
    flash: error ? { kind: "error", message: error } : null,
    body: `<h1>Service credentials</h1>
      <p class="a-lede">Held in the database, so they can be changed here rather
      than by whoever has access to the host. Values are never displayed.</p>

      ${
        revealed?.value
          ? `<div class="a-flash">
               <p><strong>${escape(revealed.name)}</strong> &mdash; copy this into your
               password manager now. Losing it makes every encrypted copy
               unreadable, and this is the only page that will ever show it.</p>
               <p><code class="a-reveal">${escape(revealed.value)}</code></p>
             </div>`
          : ""
      }

      <ul class="a-creds">${rows}</ul>

      <p class="a-note">The database connection string is deliberately absent:
      reading these rows requires it, so it cannot be one of them. It stays an
      environment variable on the host.</p>
      <p><a class="a-btn" href="/admin">Back to collections</a></p>`
  });
}

async function usersPage({ store, session, token, created, error }) {
  const users = await store.listUsers();

  const userRows = users
    .map((u) => `<li class="a-row">
      <span class="a-row-name">${escape(u.email)}${
        u.source === "environment" ? ' <span class="a-count">set on the server</span>' : ""
      }</span>
      ${
        u.source !== "environment" && u.email !== session.user.email
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

  const createdBlock = created
    ? `<div class="a-flash">
         <p>Account created for <strong>${escape(created)}</strong>.
         Give them the password you just set, and ask them to change it at
         <code>/admin/account</code> once they are signed in.</p>
       </div>`
    : "";

  return layout({
    title: "Admin accounts",
    user: session.user,
    flash: error ? { kind: "error", message: error } : null,
    body: `<h1>Admin accounts</h1>
      <p class="a-lede">Anyone listed here can edit the site.</p>
      ${createdBlock}
      <ul class="a-rows">${userRows}</ul>
      <h2 class="a-subhead">Add an admin</h2>
      <p class="a-help">Creates the account immediately. Give them the password,
      and ask them to change it at <a href="/admin/account">Change your password</a>
      once they are signed in.</p>
      <form method="post" action="/admin/users" class="a-form">
        <input type="hidden" name="csrf" value="${escape(token)}">
        <input type="hidden" name="action" value="create">
        <div class="a-field">
          <label for="f-new-email">Email</label>
          <input id="f-new-email" name="email" type="email" required>
        </div>
        <div class="a-field">
          <label for="f-new-pass">Password</label>
          <input id="f-new-pass" name="password" type="text" minlength="12" required
                 autocomplete="off" spellcheck="false">
          <span class="a-help">At least 12 characters. Shown as text so you can copy it.</span>
        </div>
        <div class="a-actions"><button class="a-btn" type="submit">Create account</button></div>
      </form>
      <p><a href="/admin">Back to collections</a></p>`
  });
}



function accountPage({ session, token, error }) {
  return layout({
    title: "Change your password",
    user: session.user,
    flash: error ? { kind: "error", message: error } : null,
    body: `<h1>Change your password</h1>
      <p class="a-lede">Signed in as ${escape(session.user.email)}. At least 12 characters.</p>
      <form method="post" action="/admin/account" class="a-form">
        <input type="hidden" name="csrf" value="${escape(token)}">
        <input type="hidden" name="username" value="${escape(session.user.email)}"
               autocomplete="username" hidden>
        <div class="a-field">
          <label for="f-current">Current password</label>
          <input id="f-current" name="currentPassword" type="password"
                 autocomplete="current-password" required autofocus>
        </div>
        <div class="a-field">
          <label for="f-new">New password</label>
          <input id="f-new" name="newPassword" type="password"
                 autocomplete="new-password" minlength="12" required>
        </div>
        <div class="a-field">
          <label for="f-confirm">Confirm new password</label>
          <input id="f-confirm" name="confirmPassword" type="password"
                 autocomplete="new-password" minlength="12" required>
        </div>
        <div class="a-actions">
          <button class="a-btn" type="submit">Change password</button>
          <a class="a-cancel" href="/admin">Cancel</a>
        </div>
      </form>`
  });
}

function firstRunPage(error, email = "") {
  return layout({
    title: "Create the first account",
    user: null,
    flash: error ? { kind: "error", message: error } : null,
    body: `<div class="a-signin">
      <h1>Create the first account</h1>
      <p>This admin has no accounts yet. The one you create here becomes the
      owner, and can add the others. This page disappears once it exists.</p>
      <form method="post" action="/admin/first-run" class="a-form a-form--signin">
        <div class="a-field">
          <label for="f-email">Email</label>
          <input id="f-email" name="email" type="email" required autofocus
                 autocomplete="username" value="${escape(email)}">
        </div>
        <div class="a-field">
          <label for="f-password">Password</label>
          <input id="f-password" name="password" type="password" required
                 autocomplete="new-password" minlength="12">
          <span class="a-help">At least 12 characters.</span>
        </div>
        <div class="a-field">
          <label for="f-confirm">Confirm password</label>
          <input id="f-confirm" name="confirm" type="password" required
                 autocomplete="new-password" minlength="12">
        </div>
        <div class="a-actions"><button class="a-btn" type="submit">Create account</button></div>
      </form>
    </div>`
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
  return `<div class="a-saved">
    <h1>Saved</h1>
    <p>Version <code>${escape((commit.commit.sha ?? "").slice(0, 7))}</code> is live now.</p>
    <p class="a-note">The site was rebuilt as you saved it. The previous version is
    kept, so a bad edit can be undone.</p>
    <p><a class="a-btn" href="${escape(backTo)}">Back to ${escape(label)}</a></p>
  </div>`;
}

function groupIndex(schema, doc, collection, token) {
  if (schema.kind === "nested") {
    const rows = doc
      .map(
        (group, i) => `<li class="a-row">
        <a class="a-row-name" href="/admin/${escape(collection)}/${i}">${escape(group.label)}</a>
        <span class="a-count">${(group[schema.childKey] ?? []).length}</span>
        <a class="a-edit" href="/admin/${escape(collection)}/tier/${i}">Edit</a>
        <form method="post" action="/admin/${escape(collection)}/tier/${i}/move" class="a-inline">
          <input type="hidden" name="csrf" value="${escape(token)}">
          <button name="direction" value="up" aria-label="Move up">&uarr;</button>
          <button name="direction" value="down" aria-label="Move down">&darr;</button>
        </form>
        <form method="post" action="/admin/${escape(collection)}/tier/${i}/delete" class="a-inline"
              onsubmit="return confirm('Remove the ${escape(group.label)} group?')">
          <input type="hidden" name="csrf" value="${escape(token)}">
          <button class="a-danger">Remove</button>
        </form>
      </li>`
      )
      .join("");
    return `<h1>${escape(schema.label)}</h1>
      <p class="a-lede">Groups appear on the page in this order. Open one to manage
      the logos inside it.</p>
      <p><a class="a-btn" href="/admin/${escape(collection)}/tier/new">Add a group</a></p>
      <ul class="a-rows">${rows}</ul>`;
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
