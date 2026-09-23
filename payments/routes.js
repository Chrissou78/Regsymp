import { escape, layout } from "../portal/render.js";
import { createAttemptLimiter } from "../admin/login-attempts.js";

/**
 * Buying a seat.
 *
 * Three pages and a webhook. The page lists what is on sale for the event the
 * site is currently about; the form sends somebody to Stripe; the webhook is
 * what actually issues the badge.
 *
 * The badge is issued from the webhook and not from the page somebody lands on
 * after paying, because that page is optional -- people close the tab, lose
 * signal in a taxi, pay on a phone that goes flat. The webhook is the only
 * event Stripe guarantees to deliver, so it is the only place a seat may be
 * granted.
 *
 * Without STRIPE_SECRET_KEY none of this is reachable: /tickets says the seats
 * are not on sale, which is true, and nothing else about the site changes.
 */

const MAX_BODY = 32 * 1024;
const MAX_WEBHOOK_BODY = 512 * 1024;

export function createPaymentPages({
  stripe,
  prices,
  events,
  attendees,
  // Called with the payment once a badge has been issued, so a confirmation
  // can be sent. Optional: a badge that exists but was not announced is a
  // recoverable problem, a payment taken and no badge is not.
  onIssued = null,
  // Whether the site is open for business. The webhook ignores it -- a payment
  // already taken has to issue its badge whatever the shopfront says -- but
  // nothing new is sold while the site is asleep.
  open = async () => true,
  attempts = createAttemptLimiter({ maxAttempts: 20, windowMs: 10 * 60 * 1000 }),
  log = console
}) {
  const html = (res, status, body) => {
    res.writeHead(status, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer"
    });
    res.end(body);
  };

  const redirect = (res, to) => {
    res.writeHead(302, { Location: to, "Cache-Control": "no-store" });
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

  /**
   * The body exactly as it arrived.
   *
   * Not decoded and not reparsed: the signature covers these bytes, and a JSON
   * round trip through this process would reorder a key and fail to verify
   * for a reason nobody would find quickly.
   */
  async function readRaw(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_WEBHOOK_BODY) throw new Error("too large");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

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

  const clientKey = (req) =>
    String(req.headers["x-forwarded-for"] ?? req.socket?.remoteAddress ?? "unknown")
      .split(",")[0]
      .trim();

  // ------------------------------------------------------------------ pages

  function closedPage(event) {
    return layout({
      title: "Tickets",
      body: `<section class="p-card">
        <h1>Tickets</h1>
        <p class="p-lede">${
          event
            ? `Seats for ${escape(event.name)} are not on sale here.`
            : "There is no event open for booking just now."
        }</p>
        <p>RegSymp is invitation-only. If you have been invited, your badge is
        waiting in <a href="/portal">your profile</a>. If you have not,
        <a href="/#signup">ask for an invitation</a> and we will be in touch.</p>
      </section>`
    });
  }

  function buyPage({ event, seats, flash = null, values = {} }) {
    const cards = seats
      .map(
        (seat) => `<article class="p-buy" style="--seat:${escape(seat.colour ?? "#1C2B4A")}">
      <header class="p-buy-head">
        <h2>${escape(seat.label)}</h2>
        <p class="p-buy-price">${escape(seat.display)}</p>
      </header>
      ${seat.note ? `<p class="p-buy-note">${escape(seat.note)}</p>` : ""}
      <form method="post" action="/tickets/buy" class="p-buy-form">
        <input type="hidden" name="category" value="${escape(seat.category)}">
        <div class="p-field">
          <label for="name-${escape(seat.category)}">Your name</label>
          <input id="name-${escape(seat.category)}" name="name" type="text"
                 autocomplete="name" required value="${escape(values.name ?? "")}">
        </div>
        <div class="p-field">
          <label for="email-${escape(seat.category)}">Email</label>
          <input id="email-${escape(seat.category)}" name="email" type="email"
                 autocomplete="email" required value="${escape(values.email ?? "")}">
          <span class="p-help">Your badge is issued to this address.</span>
        </div>
        <button class="p-btn" type="submit">Pay ${escape(seat.display)}</button>
      </form>
    </article>`
      )
      .join("");

    return layout({
      title: "Tickets",
      flash,
      wide: true,
      body: `<section class="p-card">
        <h1>${escape(event.name)}</h1>
        <p class="p-lede">${escape(
          [event.city, event.country].filter(Boolean).join(", ")
        )}${event.whenLabel ? ` · ${escape(event.whenLabel)}` : ""}</p>
        ${event.tagline ? `<p>${escape(event.tagline)}</p>` : ""}
      </section>

      <div class="p-buys">${cards}</div>

      <p class="p-fineprint">Payment is handled by Stripe. Your card details are
      entered on Stripe's own page and never reach this site.</p>`
    });
  }

  function thanksPage({ payment, event }) {
    const settled = payment?.status === "paid";
    return layout({
      title: settled ? "Thank you" : "Payment received",
      body: `<section class="p-card">
        <h1>${settled ? "Thank you" : "Nearly there"}</h1>
        ${
          settled
            ? `<p class="p-lede">Your ${escape(payment.label ?? "seat")} at
               ${escape(event?.name ?? "the symposium")} is confirmed.</p>
               <p>We have sent the details to <strong>${escape(payment.email ?? "your address")}</strong>.
               Set a password on <a href="/portal">your profile</a> and your badge is there,
               ready to add to your phone's wallet.</p>`
            : `<p class="p-lede">Your payment has gone through and we are issuing
               your badge now.</p>
               <p>This usually takes a few seconds. Reload this page, or look in
               your email — the confirmation arrives either way.</p>`
        }
        <p><a class="p-btn p-btn--quiet" href="/portal">Go to your profile</a></p>
      </section>`
    });
  }

  // -------------------------------------------------------------- the badge

  /**
   * Turn a paid session into a seat.
   *
   * Everything here has to survive being run twice on the same session, and it
   * is `markPaid` that decides: it only returns a row the first time, so a
   * redelivered webhook stops at the door rather than issuing a second badge.
   */
  async function issueFor({ sessionId, stripeEvent, email, name, origin = "" }) {
    const payment = await prices.markPaid({ sessionId, stripeEvent, email, name });
    if (!payment) return { already: true };

    const address = String(payment.email ?? "").trim().toLowerCase();
    if (!address) {
      log.error(`payment ${sessionId} has no email address; badge not issued`);
      return { payment, issued: null, why: "no email address" };
    }

    const [first, ...rest] = String(payment.name ?? "").trim().split(/\s+/).filter(Boolean);

    let guest = await attendees.byEmail(address);
    if (!guest) {
      guest = await attendees.create(
        {
          email: address,
          category: payment.category,
          firstName: first ?? null,
          lastName: rest.join(" ") || null
        },
        `paid ${payment.display}`
      );
    }

    await prices.attach(sessionId, { attendeeId: guest.id });

    // A badge they already hold is not a failure. Somebody who was invited and
    // then paid anyway has one seat and two reasons for it; refunding is a
    // decision for a person, and the payments list is where they will see it.
    const held = await attendees.ticketFor(guest.id);
    if (held) {
      await prices.attach(sessionId, { ticketId: held.id });
      return { payment, guest, issued: held, already: true };
    }

    const ticket = await attendees.issueTicket({
      attendeeId: guest.id,
      category: payment.category,
      issuedBy: `paid ${payment.display}`
    });
    await prices.attach(sessionId, { ticketId: ticket.id });

    if (onIssued) {
      // A confirmation that fails to send must not undo a badge that exists.
      try {
        await onIssued({ payment, guest, ticket, origin });
      } catch (err) {
        log.error(`could not announce payment ${sessionId}: ${err.message}`);
      }
    }

    return { payment, guest, issued: ticket };
  }

  // -------------------------------------------------------------- the routes

  async function route(req, res, url) {
    const raw = url.pathname;
    const path = raw.length > 1 ? raw.replace(/\/+$/, "") : raw;

    // ------------------------------------------------------------- webhook
    //
    // First, and before any body has been read elsewhere: the signature is
    // over the exact bytes Stripe sent.
    if (path === "/api/stripe/webhook") {
      if (req.method !== "POST") {
        res.writeHead(405, { Allow: "POST" });
        res.end();
        return true;
      }

      let body;
      try {
        body = await readRaw(req);
      } catch {
        res.writeHead(413);
        res.end();
        return true;
      }

      const read = stripe.readWebhook({ payload: body, header: req.headers["stripe-signature"] });
      if (!read.ok) {
        // 400, deliberately: Stripe retries a 5xx and gives up on a 4xx, and
        // an unverifiable body will not become verifiable on the tenth try.
        log.error(`stripe webhook refused: ${read.why}`);
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end(read.why);
        return true;
      }

      const event = read.event;
      try {
        if (event.type === "checkout.session.completed") {
          const session = event.data?.object ?? {};
          // `paid` is the field to trust. A completed session can still be
          // unpaid when the payment method settles later.
          if (session.payment_status === "paid" || session.payment_status === "no_payment_required") {
            const outcome = await issueFor({
              sessionId: session.id,
              stripeEvent: event.id,
              email: session.customer_details?.email ?? session.customer_email,
              name: session.customer_details?.name,
              origin: originOf(req)
            });
            if (outcome.issued) {
              log.log(`badge ${outcome.issued.number ?? "—"} issued for ${session.id}`);
            }
          }
        } else if (event.type === "checkout.session.expired") {
          await prices.markFailed(event.data?.object?.id, "expired");
        } else if (event.type === "checkout.session.async_payment_failed") {
          await prices.markFailed(event.data?.object?.id, "failed");
        }
      } catch (err) {
        // 500 on purpose: Stripe will retry, and a badge that failed to issue
        // because the database blinked should be issued on the retry rather
        // than quietly forgotten.
        log.error(`stripe webhook ${event.id} failed: ${err.message}`);
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("could not be handled");
        return true;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"received":true}');
      return true;
    }

    if (path !== "/tickets" && !path.startsWith("/tickets/")) return false;

    const event = await events.live();
    const selling = (await open()) && event && stripe.configured();

    // ---------------------------------------------------------- the offer
    if (path === "/tickets" && req.method === "GET") {
      if (!selling) return html(res, 200, closedPage(event)), true;
      const seats = await prices.onSaleFor(event.slug);
      if (!seats.length) return html(res, 200, closedPage(event)), true;
      return html(res, 200, buyPage({ event, seats })), true;
    }

    // ----------------------------------------------------------- buying it
    if (path === "/tickets/buy" && req.method === "POST") {
      if (!selling) return redirect(res, "/tickets"), true;

      const key = clientKey(req);
      if (attempts.isLocked(key)) {
        res.writeHead(429, { "Retry-After": String(attempts.retryAfter(key)) });
        res.end("Too many attempts. Please try again shortly.");
        return true;
      }

      let form;
      try {
        form = await readForm(req);
      } catch {
        res.writeHead(413);
        res.end();
        return true;
      }

      const seats = await prices.onSaleFor(event.slug);
      const again = (message) =>
        html(
          res,
          400,
          buyPage({
            event,
            seats,
            flash: { kind: "error", message },
            values: { name: form.name, email: form.email }
          })
        );

      const email = String(form.email ?? "").trim().toLowerCase();
      const name = String(form.name ?? "").trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email)) {
        attempts.fail(key);
        return again("Please enter an email address we can send the badge to."), true;
      }
      if (!name) {
        attempts.fail(key);
        return again("Please give the name that should appear on the badge."), true;
      }

      // The price comes from the database, never from the form. What the
      // browser sent is a choice of category and nothing else.
      const seat = await prices.priceFor(event.slug, form.category);
      if (!seat) {
        attempts.fail(key);
        return again("Those seats are not on sale."), true;
      }

      // Somebody who already holds a badge should not be sold another. They
      // are far more likely to have forgotten than to want two.
      //
      // This does tell the asker that the address holds a badge, which for a
      // Chatham House guest list is not nothing -- it is an oracle for "is
      // this person attending". The alternative is taking money for a seat
      // somebody already has, which is worse and harder to undo, so the answer
      // is to make asking slow rather than to stop answering: the attempt is
      // counted against the per-source allowance, the same as a bad address.
      const existing = await attendees.byEmail(email);
      if (existing && (await attendees.ticketFor(existing.id))) {
        attempts.fail(key);
        return (
          html(
            res,
            200,
            layout({
              title: "You already have a badge",
              body: `<section class="p-card">
              <h1>You already have a badge</h1>
              <p class="p-lede">There is a badge for ${escape(email)} waiting already.</p>
              <p>Sign in to <a href="/portal">your profile</a> to claim it. If that is
              not you, write to us and we will sort it out.</p>
            </section>`
            })
          ),
          true
        );
      }

      const origin = originOf(req);
      let session;
      try {
        session = await stripe.checkout({
          event: event.slug,
          category: seat.category,
          label: `${seat.label} · ${event.name}`,
          amount: seat.amount,
          currency: seat.currency,
          email,
          reference: `${event.slug}:${seat.category}`,
          successUrl: `${origin}/tickets/thanks?session={CHECKOUT_SESSION_ID}`,
          cancelUrl: `${origin}/tickets`
        });
      } catch (err) {
        attempts.fail(key);
        log.error(`could not open a checkout session: ${err.message}`);
        return again("We could not open the payment page. Please try again in a moment."), true;
      }

      // Written before the redirect, so a payment always has a row to land in.
      await prices.open({
        sessionId: session.id,
        eventSlug: event.slug,
        category: seat.category,
        email,
        name,
        amount: seat.amount,
        currency: seat.currency
      });

      return redirect(res, session.url), true;
    }

    // ------------------------------------------------------- coming back
    if (path === "/tickets/thanks") {
      const sessionId = url.searchParams.get("session");
      const payment = sessionId ? await prices.bySession(sessionId) : null;
      // Not proof of payment -- the webhook is -- but enough to say something
      // true to somebody standing there with a receipt in their email.
      return html(res, 200, thanksPage({ payment, event })), true;
    }

    return false;
  }

  return {
    async handle(req, res, url) {
      try {
        return await route(req, res, url);
      } catch (err) {
        log.error(`tickets: ${err.stack ?? err.message}`);
        if (!res.headersSent) {
          html(
            res,
            500,
            layout({
              title: "Something went wrong",
              body: `<section class="p-card"><h1>Something went wrong</h1>
                <p class="p-lede">That did not work, and it is our fault rather than yours.</p>
                <p>If you have been charged, your seat is safe — write to us and we
                will confirm it by hand.</p></section>`
            })
          );
        }
        return true;
      }
    },
    issueFor
  };
}
