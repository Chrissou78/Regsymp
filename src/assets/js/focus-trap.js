const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "textarea:not([disabled])",
  "select:not([disabled])",
  '[tabindex]:not([tabindex="-1"])'
].join(", ");

/**
 * Trap keyboard focus inside a container until the returned function is called.
 * Restores focus to whatever was focused beforehand.
 */
export function trapFocus(container) {
  const previouslyFocused = document.activeElement;
  const visible = () =>
    [...container.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null);

  function onKeydown(e) {
    if (e.key !== "Tab") return;
    const items = visible();
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  container.addEventListener("keydown", onKeydown);
  visible()[0]?.focus();

  return function release() {
    container.removeEventListener("keydown", onKeydown);
    if (previouslyFocused && typeof previouslyFocused.focus === "function") {
      previouslyFocused.focus();
    }
  };
}
