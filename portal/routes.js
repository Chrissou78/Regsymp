import QRCode from "qrcode";
import { csrfToken, parseCookies, verifyCsrf } from "../admin/auth.js";
import { createAttemptLimiter } from "../admin/login-attempts.js";
import {
  changePasswordPage,
  checkEmailPage,
  forgotPage,
  registerPage,
  layout,
  escape,
  profilePage,
  setPasswordPage,
  signinPage,
  ticketPage
} from "./render.js";

/**
 * The attendee portal: sign in, see your profile, see your ticket.
 *
 * A separate surface from /admin with its own cookie and its own session
 * store. Sharing either would mean one bug away from an attendee holding
 * editor privileges, and there is no reason for the two to meet.
 */

const COOKIE = "regsymp_guest";
const MAX_BODY = 64 * 1024;

/** Where a check-in scan lands. Short, because it goes in a QR code. */
export const CHECKIN_PREFIX = "/t/";

export function createPortal({
  attendees,
  sessions,
  secret,
  mail = null,
  // One sign-in form for the whole site. `admins.verify` checks the separate
  // admin credential store and `admins.issueSession` mints its cookie: the
  // two stores are never merged, and an attendee gains nothing by signing in
  // here. All that is shared is the form.
  admins = null,
  // Called after a speaker saves, to push their fields onto the public page.
  publishSpeaker = null,
  attempts = createAttemptLimiter()
}) {
  const secret$ = () => secret();

  const html = (res, status, body) => {
    res.writeHead(status, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      // A ticket page should not leak its URL to anything it links to.
      "Referrer-Policy": "no-referrer"
    });
    res.end(body);
  };

  const redirect = (res, to, headers = {}) => {
    res.writeHead(302, { Location: to, "Cache-Control": "no-store", ...headers });
    res.end();
  };

  async function readForm(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) throw new Error("That submission is too large.");
      chunks.push(chunk);
    }
    return Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString("utf8")));
  }

  function sessionFor(req) {
    const id = parseCookies(req.headers.cookie)[COOKIE];
    const session = sessions.get(id);
    return session ? { id, ...session } : null;
  }

  const EIGHT_HOURS = 8 * 60 * 60;

  /**
   * A readable cookie saying which links to show.
   *
   * The session cookies are HttpOnly, so the site's navigation — static HTML
   * built by Eleventy — cannot tell whether anybody is signed in. This one is
   * deliberately readable and grants nothing: it is a hint for the menu, and
   * every route still checks the real session.
   */
  const whoCookie = (roles) =>
    roles.length
      ? `regsymp_who=${roles.join("-")}; Secure; SameSite=Lax; Path=/; Max-Age=${EIGHT_HOURS}`
      : "regsymp_who=; Secure; SameSite=Lax; Path=/; Max-Age=0";

  function guestCookie(guest) {
    const id = sessions.create({ id: guest.id, email: guest.email }, null);
    return `${COOKIE}=${id}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${EIGHT_HOURS}`;
  }

  function startSession(res, guest, to = "/portal") {
    redirect(res, to, {
      "Set-Cookie": [guestCookie(guest), whoCookie(["guest"])]
    });
  }

  function requireCsrf(sessionId, token) {
    if (!verifyCsrf(sessionId, token, secret$())) {
      const err = new Error("That form has expired. Please reload and try again.");
      err.code = "CSRF";
      throw err;
    }
  }

  /** Rate limiting keyed per source, so one attacker cannot lock everyone out. */
  const clientKey = (req) =>
    String(req.headers["x-forwarded-for"] ?? req.socket?.remoteAddress ?? "unknown")
      .split(",")[0]
      .trim();

  function originOf(req) {
    const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "")
      .split(",")[0]
      .trim();
    if (!host) return "";
    const proto =
      String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim() ||
      (req.socket?.encrypted ? "https" : /^(localhost|127\.)/.test(host) ? "http" : "https");
    return `${proto}://${host}`;
  }

  async function route(req, res, url) {
    const raw = url.pathname;
    const path = raw.length > 1 ? raw.replace(/\/+$/, "") : raw;

    // ------------------------------------------------------- check-in scan
    // What the QR code points at. The code itself is the credential, so a
    // valid one shows the holder and an invalid one reveals nothing.
    if (path.startsWith(CHECKIN_PREFIX)) {
      const code = path.slice(CHECKIN_PREFIX.length);
      const found = await attendees.byTicketCode(code);
      html(
        res,
        found ? 200 : 404,
        layout({
          title: found ? "Valid ticket" : "Not a valid ticket",
          body: found
            ? `<div class="p-card p-card--narrow p-centre">
                 <span class="p-ticket-kind" style="border-color:${escape(
                   found.ticket.colour ?? "#1C2B4A"
                 )};color:${escape(found.ticket.colour ?? "#1C2B4A")}">${escape(
                   found.ticket.categoryLabel
                 )}</span>
                 <p class="p-ticket-number">${escape(found.ticket.label)}</p>
                 <h1>${escape(found.guest.name ?? found.guest.email)}</h1>
                 ${found.guest.company ? `<p class="p-lede">${escape(found.guest.company)}</p>` : ""}
                 ${
                   found.ticket.areas?.length
                     ? `<p class="p-note">Access: ${found.ticket.areas
                         .map((a) => escape(a.replace(/^side:/, "")))
                         .join(", ")}</p>`
                     : ""
                 }
                 ${
                   found.ticket.checkedInAt
                     ? `<p class="p-flash p-flash--ok">Already checked in at ${escape(
                         new Date(found.ticket.checkedInAt).toISOString().slice(11, 16)
                       )}</p>`
                     : ""
                 }
               </div>`
            : `<div class="p-card p-card--narrow p-centre">
                 <h1>Not a valid ticket</h1>
                 <p class="p-lede">This code does not match a ticket for this event.</p>
               </div>`
        })
      );
      return true;
    }

    if (path !== "/portal" && !path.startsWith("/portal/")) return false;

    // -------------------------------------------------------- claim/reset
    for (const purpose of ["claim", "reset"]) {
      if (!path.startsWith(`/portal/${purpose}/`)) continue;
      const token = path.slice(`/portal/${purpose}/`.length);
      const found = await attendees.findToken(token, purpose);

      if (!found) {
        html(res, 400, layout({
          title: "Link not valid",
          flash: { kind: "error", message: "That link is invalid, already used, or expired." },
          body: `<div class="p-card p-card--narrow">
                   <p>Ask the organisers for a new one, or
                   <a href="/portal/forgot">request a password reset</a>.</p>
                 </div>`
        }));
        return true;
      }

      if (req.method === "GET") {
        html(res, 200, setPasswordPage({ token, purpose, email: found.email }));
        return true;
      }

      const form = await readForm(req);
      if (form.password !== form.confirm) {
        html(res, 400, setPasswordPage({
          token, purpose, email: found.email, error: "Those passwords do not match."
        }));
        return true;
      }

      try {
        await attendees.redeemToken(token, purpose, form.password);
      } catch (err) {
        html(res, 400, setPasswordPage({ token, purpose, email: found.email, error: err.message }));
        return true;
      }

      const guest = await attendees.byId(found.attendeeId);
      await attendees.recordLogin(guest.id);
      startSession(res, guest);
      return true;
    }

    // --------------------------------------------------------- registration
    // Open to anyone. An account is identity, not admission: a ticket is
    // issued separately by an admin, which is what keeps the guest list a
    // whitelist rather than a race for the first hundred sign-ups.
    if (path === "/portal/register") {
      if (req.method === "GET") {
        if (sessionFor(req)) return redirect(res, "/portal"), true;
        html(res, 200, registerPage());
        return true;
      }

      const source = clientKey(req);
      if (attempts.isLocked(source)) {
        html(res, 429, registerPage({ error: "Too many attempts. Please try again later." }));
        return true;
      }

      const form = await readForm(req);
      const values = {
        firstName: String(form.firstName ?? "").trim(),
        lastName: String(form.lastName ?? "").trim(),
        company: String(form.company ?? "").trim(),
        email: String(form.email ?? "").trim()
      };

      // Filled in only by something automated. Answer as though it worked,
      // so a bot learns nothing from the difference.
      if (String(form.website ?? "").trim()) {
        html(res, 200, checkEmailPage({ email: values.email }));
        return true;
      }

      let guest;
      try {
        guest = await attendees.register({ ...values, password: String(form.password ?? "") });
      } catch (err) {
        attempts.fail(source);
        if (err.code === "DUPLICATE") {
          // Do not confirm that the address is taken. Send the owner a reset
          // link instead: if it is their address they can get in, and if it
          // is not, they learn nothing.
          const existing = await attendees.byEmail(values.email);
          if (existing && mail?.configured()) {
            const token = await attendees.createToken(existing.id, "reset");
            await mail
              .sendResetLink({ to: existing.email, url: `${originOf(req)}/portal/reset/${token}` })
              .catch((e) => console.error("reset email failed:", e.message));
          }
          html(res, 200, checkEmailPage({ email: values.email }));
          return true;
        }
        html(res, 400, registerPage({ error: err.message, values }));
        return true;
      }

      attempts.succeed(source);

      if (mail?.configured()) {
        const token = await attendees.createToken(guest.id, "verify");
        await mail
          .sendVerificationLink({ to: guest.email, url: `${originOf(req)}/portal/verify/${token}` })
          .catch((err) => console.error("verification email failed:", err.message));
      }

      // Signed in straight away: the account works, it just cannot hold a
      // ticket until the address is confirmed.
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Set-Cookie": [guestCookie(guest), whoCookie(["guest"])]
      });
      res.end(checkEmailPage({ email: guest.email }));
      return true;
    }

    // ------------------------------------------------------- email verified
    if (path.startsWith("/portal/verify/")) {
      const token = path.slice("/portal/verify/".length);
      try {
        await attendees.verifyEmail(token);
      } catch (err) {
        html(res, 400, layout({
          title: "Link not valid",
          flash: { kind: "error", message: err.message },
          body: `<div class="p-card p-card--narrow">
                   <p>Sign in and ask for a new one from your profile.</p>
                   <p><a class="p-quiet" href="/portal/signin">Sign in</a></p>
                 </div>`
        }));
        return true;
      }
      html(res, 200, layout({
        title: "Email confirmed",
        flash: { kind: "ok", message: "Your email address is confirmed." },
        body: `<div class="p-card p-card--narrow">
                 <h1>Thank you</h1>
                 <p class="p-lede">Your address is confirmed. The organisers can
                 now issue you a ticket if you have a place.</p>
                 <p><a class="p-btn" href="/portal">Go to your profile</a></p>
               </div>`
      }));
      return true;
    }

    // ------------------------------------------------------------- sign in
    if (path === "/portal/signin") {
      if (req.method === "GET") {
        if (sessionFor(req)) return redirect(res, "/portal"), true;
        html(res, 200, signinPage());
        return true;
      }

      const source = clientKey(req);
      if (attempts.isLocked(source)) {
        const wait = Math.ceil(attempts.retryAfter(source) / 60);
        html(res, 429, signinPage({
          error: `Too many attempts. Try again in ${wait} minute${wait === 1 ? "" : "s"}.`
        }));
        return true;
      }

      const form = await readForm(req);
      const email = String(form.email ?? "").trim().toLowerCase();
      const password = String(form.password ?? "");

      // Both stores are tried, because one address may legitimately be both an
      // attendee and an admin — with different passwords. Neither result
      // grants anything the other has.
      const isGuest = await attendees.verify(email, password);
      const isAdmin = admins ? await admins.verify(email, password) : false;

      if (!isGuest && !isAdmin) {
        attempts.fail(source);
        // One message for every cause, so the form cannot be used to work out
        // who is on the guest list, or who administers the site.
        html(res, 401, signinPage({ error: "Those details do not match an account.", email }));
        return true;
      }

      attempts.succeed(source);

      const cookies = [];
      const roles = [];

      if (isGuest) {
        const guest = await attendees.byEmail(email);
        await attendees.recordLogin(guest.id);
        cookies.push(guestCookie(guest));
        roles.push("guest");
      }
      if (isAdmin) {
        cookies.push(admins.issueSession(email));
        roles.push("admin");
      }
      cookies.push(whoCookie(roles));

      // An attendee lands on their profile; somebody who is only an admin has
      // no profile to land on.
      redirect(res, isGuest ? "/portal" : "/admin", { "Set-Cookie": cookies });
      return true;
    }

    // -------------------------------------------------------------- forgot
    if (path === "/portal/forgot") {
      if (req.method === "GET") {
        html(res, 200, forgotPage());
        return true;
      }

      const form = await readForm(req);
      const email = String(form.email ?? "").trim().toLowerCase();
      const guest = await attendees.byEmail(email);

      // Always the same answer. Saying "no such account" would turn this into
      // a guest-list lookup for anybody who asked.
      if (guest && mail?.configured()) {
        const token = await attendees.createToken(guest.id, "reset");
        await mail
          .sendResetLink({ to: guest.email, url: `${originOf(req)}/portal/reset/${token}` })
          .catch((err) => console.error("reset email failed:", err.message));
      }
      html(res, 200, forgotPage({ sent: true }));
      return true;
    }

    // ---------------------------------------------------- everything below
    const session = sessionFor(req);
    if (!session) {
      redirect(res, "/portal/signin");
      return true;
    }

    const guest = await attendees.byId(session.user.id);
    if (!guest) {
      sessions.destroy(session.id);
      redirect(res, "/portal/signin", {
        "Set-Cookie": [
          `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`,
          whoCookie([])
        ]
      });
      return true;
    }

    const token = csrfToken(session.id, secret$());

    if (path === "/portal/signout") {
      if (req.method === "POST") {
        const form = await readForm(req);
        requireCsrf(session.id, form.csrf);
        sessions.destroy(session.id);
      }
      redirect(res, "/", {
        "Set-Cookie": [
          `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`,
          whoCookie([])
        ]
      });
      return true;
    }

    if (path === "/portal/resend") {
      const form = await readForm(req);
      requireCsrf(session.id, form.csrf);

      if (!guest.emailVerified && mail?.configured()) {
        const fresh = await attendees.createToken(guest.id, "verify");
        await mail
          .sendVerificationLink({ to: guest.email, url: `${originOf(req)}/portal/verify/${fresh}` })
          .catch((err) => console.error("verification email failed:", err.message));
      }
      html(res, 200, checkEmailPage({ email: guest.email }));
      return true;
    }

    if (path === "/portal/ticket") {
      const ticket = await attendees.ticketFor(guest.id);
      if (!ticket) {
        redirect(res, "/portal");
        return true;
      }

      const checkinUrl = `${originOf(req)}${CHECKIN_PREFIX}${ticket.code}`;
      const qr = await QRCode.toString(checkinUrl, {
        type: "svg",
        errorCorrectionLevel: "M",
        margin: 1,
        width: 260
      });

      html(res, 200, ticketPage({ guest, ticket, qr, token }));
      return true;
    }

    if (path === "/portal/password") {
      if (req.method === "GET") {
        html(res, 200, changePasswordPage({ guest, token }));
        return true;
      }

      const form = await readForm(req);
      requireCsrf(session.id, form.csrf);

      if (!(await attendees.verify(guest.email, String(form.current ?? "")))) {
        html(res, 400, changePasswordPage({ guest, token, error: "Your current password is not correct." }));
        return true;
      }
      if (form.password !== form.confirm) {
        html(res, 400, changePasswordPage({ guest, token, error: "Those passwords do not match." }));
        return true;
      }

      try {
        await attendees.setPassword(guest.id, String(form.password ?? ""));
      } catch (err) {
        html(res, 400, changePasswordPage({ guest, token, error: err.message }));
        return true;
      }

      // Every other session for this account goes, in case the password was
      // changed because it leaked.
      sessions.destroyOthersFor(guest.email, session.id);
      html(res, 200, changePasswordPage({ guest, token, saved: true }));
      return true;
    }

    if (path === "/portal") {
      const ticket = await attendees.ticketFor(guest.id);

      if (req.method === "GET") {
        html(res, 200, profilePage({ guest, ticket, token }));
        return true;
      }

      const form = await readForm(req);
      requireCsrf(session.id, form.csrf);

      const socials = { ...(guest.socials ?? {}) };
      for (const network of ["linkedin", "x"]) {
        const value = String(form[network] ?? "").trim();
        if (value) socials[network] = value;
        else delete socials[network];
      }

      const fields = {
        firstName: String(form.firstName ?? "").trim() || null,
        lastName: String(form.lastName ?? "").trim() || null,
        company: String(form.company ?? "").trim() || null,
        position: String(form.position ?? "").trim() || null,
        country: String(form.country ?? "").trim() || null,
        birthDate: String(form.birthDate ?? "").trim() || null,
        socials
      };
      // Role is not editable here, and neither is email: an attendee must not
      // be able to promote themselves or take over another address.
      if (guest.role === "speaker") {
        fields.description = String(form.description ?? "").trim() || null;
      }

      try {
        await attendees.update(guest.id, fields);
        await attendees.recordConsent(guest.id, form.consentMarketing === "yes");

        // A linked speaker's own words belong on the public page. Not awaited
        // for its result: the profile is already saved, and a rebuild failing
        // must not make a successful save look broken.
        if (guest.role === "speaker" && guest.speakerSlug && publishSpeaker) {
          await publishSpeaker(await attendees.byId(guest.id)).catch((err) =>
            console.error("publishing the speaker page failed:", err.message)
          );
        }
      } catch (err) {
        html(res, 400, profilePage({ guest, ticket, token, error: err.message }));
        return true;
      }

      html(res, 200, profilePage({
        guest: await attendees.byId(guest.id),
        ticket,
        token,
        saved: true
      }));
      return true;
    }

    html(res, 404, layout({
      title: "Not found",
      guest,
      token,
      body: `<div class="p-card p-card--narrow"><h1>Not found</h1>
             <p><a class="p-quiet" href="/portal">Back to your profile</a></p></div>`
    }));
    return true;
  }

  /**
   * Every throw still has to produce a page. Without this an unexpected error
   * leaves the request open until the browser gives up, showing nothing.
   */
  async function handle(req, res, url) {
    try {
      return await route(req, res, url);
    } catch (err) {
      if (res.headersSent || res.writableEnded) return true;
      const csrf = err?.code === "CSRF";
      if (!csrf) console.error("portal error:", err?.message ?? err);
      html(res, csrf ? 403 : 500, layout({
        title: "Something went wrong",
        flash: {
          kind: "error",
          message: csrf ? err.message : "Something went wrong. Nothing was saved."
        },
        body: `<div class="p-card p-card--narrow">
                 <p><a class="p-quiet" href="/portal">Back to your profile</a></p>
               </div>`
      }));
      return true;
    }
  }

  return { handle };
}
