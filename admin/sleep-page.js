import { escape, layout } from "./render.js";

/**
 * The page the site shows while it is closed.
 *
 * Server-rendered rather than built by Eleventy because the words come from a
 * setting and the decision to show it is made before any built page is
 * reached. It borrows the site's own stylesheet so that being closed still
 * looks like the same organisation, rather than like something broken.
 *
 * Served at 200. A 503 would be right for an outage, and this is not one: it
 * is a deliberate page saying a deliberate thing, and it may be up for weeks
 * between events.
 */
export function sleepPage({ heading, message }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(heading)} — RegSymp</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@400;600&family=Inter:wght@400;500;600&family=Playfair+Display:ital,wght@0,400;0,600;1,400&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/assets/css/styles.css">
<style>
  .sleep {
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 22px;
    padding: 48px 24px;
    text-align: center;
    background: var(--navy-deep, #0E1626);
    color: #F6F3EC;
  }
  .sleep-mark {
    font-family: var(--serif, Georgia, serif);
    font-size: 13px;
    letter-spacing: 0.34em;
    text-transform: uppercase;
    color: rgba(246, 243, 236, 0.55);
    margin: 0;
  }
  .sleep h1 {
    font-family: var(--display, Georgia, serif);
    font-size: clamp(38px, 9vw, 74px);
    font-weight: 400;
    line-height: 1.05;
    margin: 0;
    color: #F6F3EC;
  }
  .sleep p.sleep-said {
    max-width: 30em;
    margin: 0;
    font-size: clamp(15px, 2.4vw, 18px);
    line-height: 1.7;
    color: rgba(246, 243, 236, 0.76);
  }
  .sleep-rule {
    width: 54px;
    height: 1px;
    background: var(--gold, #B8963A);
    margin: 6px 0;
  }
  .sleep-foot {
    margin: 18px 0 0;
    font-size: 12px;
    letter-spacing: 0.08em;
    color: rgba(246, 243, 236, 0.42);
  }
  .sleep-foot a { color: inherit; text-decoration: underline; text-underline-offset: 3px; }
</style>
</head>
<body>
<main class="sleep">
  <p class="sleep-mark">RegSymp</p>
  <h1>${escape(heading)}</h1>
  <div class="sleep-rule"></div>
  <p class="sleep-said">${escape(message)}</p>
  <p class="sleep-foot">
    Already with us? <a href="/portal">Your profile and badge</a>.
  </p>
</main>
</body>
</html>`;
}

/** The switch, and the words it puts on the door. */
export function sleepSettingsPage({ sleep, session, token, flash = null }) {
  return layout({
    title: "Sleep mode",
    user: session.user,
    flash,
    body: `<h1>Sleep mode</h1>
      <p class="a-lede">Between events the site can say so, instead of showing
      the last one as though it were still coming. Everything else keeps
      working: the admin, everybody's profile and badge, and the check-in codes.
      While it is asleep you still see the real site — anybody signed in here
      does — so there is no need to wake it up to look at it.</p>

      <p class="a-note">Currently
        <strong>${sleep.on ? "asleep" : "awake"}</strong>.
        ${sleep.on ? '<a href="/" target="_blank" rel="noopener">See what visitors see</a> (sign out first, or use a private window).' : ""}
      </p>

      <form method="post" action="/admin/sleep" class="a-form">
        <input type="hidden" name="csrf" value="${escape(token)}">

        <label class="a-check">
          <input type="checkbox" name="on" value="yes"${sleep.on ? " checked" : ""}>
          <span>Put the site to sleep</span>
        </label>

        <div class="a-field">
          <label for="f-sleep-heading">Heading</label>
          <input id="f-sleep-heading" name="heading" value="${escape(sleep.heading)}" maxlength="80">
        </div>

        <div class="a-field">
          <label for="f-sleep-message">Message</label>
          <textarea id="f-sleep-message" name="message" rows="3" maxlength="400">${escape(sleep.message)}</textarea>
          <span class="a-help">A sentence or two. Left empty, the default is used.</span>
        </div>

        <div class="a-actions"><button class="a-btn" type="submit">Save</button></div>
      </form>

      <p><a href="/admin">Back to collections</a></p>`
  });
}
