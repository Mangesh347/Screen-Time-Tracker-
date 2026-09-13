/**
 * Website visual theme — mirrors extension Material You / Editorial / Minimal.
 * Persists to localStorage; respects prefers-color-scheme when mode is "system".
 */
(function () {
  const STORAGE_VISUAL = "stt_site_visual";
  const STORAGE_MODE = "stt_site_mode";
  const VISUALS = ["material", "editorial", "minimal"];

  function normalizeVisual(id) {
    return VISUALS.includes(id) ? id : "material";
  }

  function resolveMode(mode) {
    if (mode === "dark" || mode === "light") return mode;
    try {
      return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    } catch {
      return "light";
    }
  }

  function readStored() {
    let visual = "material";
    let modePref = "system";
    try {
      visual = normalizeVisual(localStorage.getItem(STORAGE_VISUAL) || "material");
      modePref = localStorage.getItem(STORAGE_MODE) || "system";
      if (!["system", "light", "dark"].includes(modePref)) modePref = "system";
    } catch {}
    return { visual, modePref };
  }

  function apply({ visual, modePref }, animate) {
    const root = document.documentElement;
    const tone = resolveMode(modePref);
    if (animate) root.classList.add("theme-switching");
    root.setAttribute("data-visual", normalizeVisual(visual));
    root.setAttribute("data-mode", tone);
    root.setAttribute("data-theme", "auto");
    root.setAttribute("data-m3", "expressive");
    try {
      localStorage.setItem(STORAGE_VISUAL, normalizeVisual(visual));
      localStorage.setItem(STORAGE_MODE, modePref);
    } catch {}
    syncControls(normalizeVisual(visual), modePref, tone);
    if (animate) {
      requestAnimationFrame(function () {
        setTimeout(function () {
          root.classList.remove("theme-switching");
        }, 420);
      });
    }
  }

  function syncControls(visual, modePref, tone) {
    document.querySelectorAll("[data-visual-set]").forEach(function (el) {
      const on = el.getAttribute("data-visual-set") === visual;
      el.classList.toggle("on", on);
      el.setAttribute("aria-pressed", on ? "true" : "false");
    });
    document.querySelectorAll("[data-mode-toggle]").forEach(function (el) {
      const next = tone === "dark" ? "light" : "dark";
      el.setAttribute("aria-label", next === "dark" ? "Switch to dark mode" : "Switch to light mode");
      el.title = modePref === "system" ? "Theme follows system (click to lock)" : "Toggle light / dark";
      el.textContent = tone === "dark" ? "☀" : "☾";
    });
  }

  function init() {
    const stored = readStored();
    apply(stored, false);

    document.addEventListener("click", function (e) {
      const chip = e.target.closest("[data-visual-set]");
      if (chip) {
        const visual = normalizeVisual(chip.getAttribute("data-visual-set"));
        apply({ visual, modePref: readStored().modePref }, true);
        return;
      }
      const modeBtn = e.target.closest("[data-mode-toggle]");
      if (modeBtn) {
        const cur = resolveMode(readStored().modePref);
        const next = cur === "dark" ? "light" : "dark";
        apply({ visual: readStored().visual, modePref: next }, true);
      }
    });

    try {
      window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function () {
        const s = readStored();
        if (s.modePref === "system") apply(s, true);
      });
    } catch {}
  }

  // Apply ASAP to avoid flash (inline early script also sets attrs)
  apply(readStored(), false);
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  window.STTSiteTheme = {
    apply: function (visual, modePref) {
      apply(
        {
          visual: visual || readStored().visual,
          modePref: modePref || readStored().modePref,
        },
        true
      );
    },
    get: readStored,
  };
})();
