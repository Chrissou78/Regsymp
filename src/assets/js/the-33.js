import { trapFocus } from "./focus-trap.js";

/**
 * The 33: clicking an edition opens the form with that edition ticked.
 *
 * The form is in the page already and posts to /api/the-33 on its own, so
 * somebody whose JavaScript did not run still has a working form — this only
 * makes it a dialog, pre-ticks the card they clicked, and answers in place
 * instead of navigating.
 *
 * Which is also why nothing here builds markup. The chips, the fields and the
 * endpoint are all rendered by the template from the events table; if an
 * edition is added, this file does not change.
 */
export function theThirtyThree() {
  const overlay = document.getElementById("the33-overlay");
  const form = document.getElementById("the33-form");
  if (!overlay || !form) return;

  const done = document.getElementById("the33-done");
  const doneMsg = document.getElementById("the33-done-msg");
  const err = document.getElementById("the33-err");
  const submit = document.getElementById("the33-submit");
  const started = document.getElementById("the33-started");
  const chips = [...overlay.querySelectorAll(".the33-chip")];

  let release = null;
  let opener = null;

  // The timing check on the server measures from here. Set by script rather
  // than rendered, because a cached page would carry a stale timestamp and
  // every submission would look suspiciously fast.
  if (started) started.value = String(Date.now());

  const tick = (chip, on) => {
    chip.classList.toggle("is-on", on);
    chip.querySelector("input").checked = on;
  };

  function open(slug, from) {
    // The card you clicked, and only that one. Somebody who wants three ticks
    // the other two; somebody who wants one is already finished.
    chips.forEach((chip) => tick(chip, chip.dataset.key === slug));

    err.hidden = true;
    err.textContent = "";
    form.hidden = false;
    done.hidden = true;
    overlay.hidden = false;
    document.body.style.overflow = "hidden";

    opener = from ?? null;
    release = trapFocus(overlay);
    document.getElementById("the33-name")?.focus();
  }

  function close() {
    overlay.hidden = true;
    document.body.style.overflow = "";
    if (release) {
      release();
      release = null;
    }
    opener?.focus();
  }

  document.querySelectorAll(".the33-card").forEach((card) => {
    const go = () => open(card.dataset.edition, card);
    card.addEventListener("click", go);
    card.addEventListener("keydown", (e) => {
      // A div with role=button has to do this itself.
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        go();
      }
    });
  });

  // The whole chip is the target, not the eight pixels of the checkbox.
  chips.forEach((chip) => {
    chip.addEventListener("click", (e) => {
      e.preventDefault();
      tick(chip, !chip.classList.contains("is-on"));
    });
  });

  document.getElementById("the33-close")?.addEventListener("click", close);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !overlay.hidden) close();
  });

  /** "London", or "London, Davos and Barcelona". */
  const listOf = (names) =>
    names.length < 2
      ? (names[0] ?? "")
      : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    err.hidden = true;

    const body = new FormData(form);
    const picked = chips
      .filter((chip) => chip.classList.contains("is-on"))
      .map((chip) => chip.querySelector("input").value);

    if (!picked.length) {
      err.textContent = "Please select at least one edition.";
      err.hidden = false;
      return;
    }

    submit.disabled = true;
    const said = submit.textContent;
    submit.textContent = "Sending…";

    try {
      const res = await fetch(form.action, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: body.get("name"),
          email: body.get("email"),
          company: body.get("company"),
          editions: picked,
          website: body.get("website"),
          startedAt: body.get("startedAt"),
          source: body.get("source")
        })
      });
      const answer = await res.json().catch(() => ({}));

      if (!res.ok) {
        err.textContent = answer.error || "That did not go through. Please try again.";
        err.hidden = false;
        return;
      }

      const first = String(body.get("name") ?? "").trim().split(/\s+/)[0];
      // The place, without the date: it reads as a sentence rather than a
      // receipt, and they have just chosen the dates themselves.
      const places = picked.map((p) => p.split(" — ")[0]);
      doneMsg.textContent =
        `${first}, your interest has been registered for ${listOf(places)}. ` +
        "The programme chairs will be in touch.";
      form.hidden = true;
      done.hidden = false;
      done.querySelector("h3")?.focus?.();
    } catch {
      err.textContent = "That did not go through. Please check your connection and try again.";
      err.hidden = false;
    } finally {
      submit.disabled = false;
      submit.textContent = said;
    }
  });
}
