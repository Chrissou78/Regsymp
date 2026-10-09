/**
 * The hero accordion: two panels, one open, rotating on their own.
 *
 * A click stops the rotation for good. Somebody who has chosen a panel is
 * reading it, and moving it under them is the one thing a carousel must not
 * do — so the timer is cancelled rather than merely restarted.
 *
 * It rotates even when the operating system asks for reduced motion. The CSS
 * drops the sliding and the progress line there, so what reduced motion gets
 * is an instant swap rather than no swap at all, which is the difference
 * between a quieter page and a page missing half its content.
 */
// Ten seconds. Long enough to read the panel and the dates under it; the
// progress line in the stylesheet is timed to match, so if this changes
// the `transition: width 10s` on .acc-progress changes with it.
const DWELL = 10000;

export function heroAccordion() {
  const acc = document.getElementById("acc");
  if (!acc) return;

  const panels = [...acc.querySelectorAll(".acc-panel")];
  if (panels.length < 2) return;

  let timer = null;
  let stopped = false;
  let at = 0;

  function open(next) {
    at = next;
    panels.forEach((panel, i) => {
      const on = i === next;
      panel.classList.toggle("is-open", on);
      panel.setAttribute("aria-expanded", String(on));
      panel.classList.remove("ticking");
    });
    if (!stopped) tick();
  }

  function tick() {
    const panel = panels[at];
    const bar = panel.querySelector(".acc-progress");
    if (bar) {
      // Restart the line rather than letting it animate from wherever it
      // was: without the reflow the transition is never re-triggered.
      bar.style.transition = "none";
      bar.style.width = "0";
      void bar.offsetWidth;
      bar.style.transition = "";
    }
    panel.classList.add("ticking");
    clearTimeout(timer);
    timer = setTimeout(() => open((at + 1) % panels.length), DWELL);
  }

  function halt() {
    stopped = true;
    clearTimeout(timer);
    panels.forEach((panel) => panel.classList.remove("ticking"));
  }

  // Clicking a collapsed panel opens it. The open one is inert, so a click
  // on the photograph does not count as a click on anything.
  panels.forEach((panel, i) => {
    const act = () => {
      if (panel.classList.contains("is-open")) return;
      halt();
      open(i);
    };
    panel.addEventListener("click", act);
    panel.addEventListener("keydown", (e) => {
      if (panel.classList.contains("is-open")) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        act();
      }
    });
  });

  // Only "See More" navigates, and it stops the click reaching the panel.
  panels.forEach((panel) => {
    const cta = panel.querySelector(".acc-cta");
    if (!cta) return;
    cta.setAttribute("role", "link");
    cta.setAttribute("tabindex", "0");

    const go = (e) => {
      e.stopPropagation();
      const target = panel.dataset.target && document.querySelector(panel.dataset.target);
      if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
    };
    cta.addEventListener("click", go);
    cta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        go(e);
      }
    });
  });

  tick();
}
