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

  // ------------------------------------------------------------ who is signed in
  //
  // These pages are static, so the menu cannot know at build time whether
  // anybody is signed in. The server sets a readable `regsymp_who` cookie
  // alongside the real session cookies, which stay HttpOnly. This one grants
  // nothing — every route still checks the session — it only decides which
  // links to show.
  const who = (document.cookie.match(/(?:^|;\s*)regsymp_who=([^;]*)/) || [])[1] || "";
  const roles = decodeURIComponent(who).split("-").filter(Boolean);

  if (roles.includes("admin")) {
    document.querySelectorAll("[data-admin-link]").forEach((el) => {
      el.hidden = false;
    });
  }

  // Somebody signed in does not need to be invited to sign in. A guest gets
  // their profile; an admin with no attendee profile has nowhere for this
  // link to go, and the Admin link beside it already says "Admin" — showing
  // both put the word on screen twice.
  if (roles.includes("guest")) {
    document.querySelectorAll("[data-account-link]").forEach((el) => {
      el.setAttribute("href", "/portal");
      // Keep the space the markup had before the arrow: replacing
      // textContent wholesale dropped it and gave "My Profile→".
      const arrow = el.querySelector(".arrow");
      el.textContent = arrow ? "My Profile " : "My Profile";
      if (arrow) el.appendChild(arrow);
    });
  } else if (roles.includes("admin")) {
    document.querySelectorAll("[data-account-link]").forEach((el) => {
      el.hidden = true;
    });
  }

  // Escape closes the drawer.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && drawer?.classList.contains("open")) setDrawer(false);
  });
})();
