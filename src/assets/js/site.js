import { trapFocus } from "./focus-trap.js";

(function () {
  // ---------------------------------------------------------------- nav state
  const nav = document.getElementById("nav");
  if (nav && !nav.classList.contains("scrolled")) {
    const onScroll = () => nav.classList.toggle("scrolled", window.scrollY > 60);
    document.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
  }

  // ------------------------------------------------------------- mobile drawer
  const burger = document.getElementById("burger");
  const drawer = document.getElementById("drawer");
  const drawerClose = document.getElementById("drawerClose");
  let releaseDrawer = null;

  function setDrawer(open) {
    if (!drawer) return;
    drawer.classList.toggle("open", open);
    drawer.setAttribute("aria-hidden", String(!open));
    burger?.setAttribute("aria-expanded", String(open));
    document.body.style.overflow = open ? "hidden" : "";
    if (open) {
      releaseDrawer = trapFocus(drawer);
    } else {
      releaseDrawer?.();
      releaseDrawer = null;
    }
  }

  burger?.addEventListener("click", () => setDrawer(true));
  drawerClose?.addEventListener("click", () => setDrawer(false));
  drawer?.querySelectorAll("a").forEach((a) =>
    a.addEventListener("click", () => setDrawer(false))
  );

  // ------------------------------------------------------------ city selector
  // Editions are separate pages, so this navigates rather than swapping content.
  const cityPick = document.getElementById("cityPick");
  const cityBtn = document.getElementById("cityPickBtn");

  cityBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = cityPick.classList.toggle("open");
    cityBtn.setAttribute("aria-expanded", String(open));
  });

  document.addEventListener("click", () => {
    cityPick?.classList.remove("open");
    cityBtn?.setAttribute("aria-expanded", "false");
  });

  document.querySelectorAll(".city-menu-item[data-edition-url]").forEach((item) => {
    const go = () => {
      window.location.href = item.dataset.editionUrl;
    };
    item.addEventListener("click", (e) => {
      e.stopPropagation();
      go();
    });
    item.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        go();
      }
    });
  });

  // -------------------------------------------------------------- agenda tabs
  const tabs = [...document.querySelectorAll(".tab[role=tab]")];

  function selectTab(tab) {
    tabs.forEach((t) => {
      const selected = t === tab;
      t.classList.toggle("active", selected);
      t.setAttribute("aria-selected", String(selected));
      const panel = document.getElementById(t.getAttribute("aria-controls"));
      panel?.classList.toggle("active", selected);
    });
    tab.focus();
  }

  tabs.forEach((t, i) => {
    t.addEventListener("click", () => selectTab(t));
    t.addEventListener("keydown", (e) => {
      if (e.key === "ArrowRight") selectTab(tabs[(i + 1) % tabs.length]);
      if (e.key === "ArrowLeft") selectTab(tabs[(i - 1 + tabs.length) % tabs.length]);
    });
  });

  // ------------------------------------------------------------ gallery arrows
  document.querySelectorAll("[data-gallery-prev], [data-gallery-next]").forEach((btn) => {
    const trackId = btn.dataset.galleryPrev || btn.dataset.galleryNext;
    const track = document.getElementById(trackId);
    if (!track) return;
    const dir = btn.hasAttribute("data-gallery-prev") ? -1 : 1;
    btn.addEventListener("click", () => {
      const item = track.querySelector(".gallery-item");
      if (!item) return;
      const styles = getComputedStyle(track);
      const gap = parseFloat(styles.columnGap || styles.gap || "0");
      track.scrollBy({
        left: (item.getBoundingClientRect().width + gap) * dir,
        behavior: "smooth"
      });
    });
  });

  // ------------------------------------------------------------ scroll reveals
  const io = new IntersectionObserver(
    (entries) =>
      entries.forEach((e) => {
        if (e.isIntersecting) {
          e.target.classList.add("in");
          io.unobserve(e.target);
        }
      }),
    { threshold: 0.08, rootMargin: "0px 0px -80px 0px" }
  );
  document.querySelectorAll(".reveal").forEach((el) => io.observe(el));

  // --------------------------------------------------------- invitation modal
  const modal = document.getElementById("inviteModal");
  const form = document.getElementById("inviteForm");
  const statusEl = document.getElementById("inviteStatus");
  let releaseModal = null;

  function openModal(e) {
    if (!modal) return;
    e?.preventDefault();
    modal.hidden = false;
    document.body.style.overflow = "hidden";
    const started = document.getElementById("inviteStartedAt");
    if (started) started.value = String(Date.now());
    releaseModal = trapFocus(modal);
  }

  function closeModal() {
    if (!modal || modal.hidden) return;
    modal.hidden = true;
    document.body.style.overflow = "";
    releaseModal?.();
    releaseModal = null;
  }

  document.querySelectorAll("[data-invite-trigger]").forEach((el) =>
    el.addEventListener("click", openModal)
  );
  document.querySelectorAll("[data-invite-close]").forEach((el) =>
    el.addEventListener("click", closeModal)
  );

  // One Escape handler for both overlays
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (modal && !modal.hidden) closeModal();
    else if (drawer?.classList.contains("open")) setDrawer(false);
  });

  form?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const submit = form.querySelector(".invite-submit");
    submit.disabled = true;
    statusEl.textContent = "Sending…";
    statusEl.classList.remove("is-error");

    try {
      const res = await fetch("/api/request-invitation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(Object.fromEntries(new FormData(form)))
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Something went wrong.");
      form.hidden = true;
      statusEl.textContent = "Thank you. We will be in touch.";
    } catch (err) {
      statusEl.textContent = err.message;
      statusEl.classList.add("is-error");
      submit.disabled = false;
    }
  });
})();
