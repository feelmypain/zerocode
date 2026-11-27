declare global {
  interface Window {
    __ZEROCODE_BOOT_START__?: number;
  }
}

// Covers the 440ms one-shot icon entrance plus a poised beat before cross-revealing the app.
const MIN_BOOT_ICON_MS = 680;
const REVEAL_CLEANUP_MS = 560;

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

function nextPaintedFrame(): Promise<void> {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => resolve());
    });
  });
}

/**
 * Holds the icon-only splash until React paints its first frame and the icon entrance settles,
 * then cross-reveals the app and removes the splash overlay cleanly.
 */
export function revealBootedApp(): void {
  const bootShell = document.getElementById("boot-shell");
  if (!bootShell) {
    delete document.documentElement.dataset.appBooting;
    return;
  }
  if (bootShell.querySelector("#boot-error")) return;

  const finish = () => {
    if (bootShell.querySelector("#boot-error")) return;
    bootShell.remove();
    delete document.documentElement.dataset.appBooting;
  };

  if (prefersReducedMotion()) {
    finish();
    return;
  }

  const startReveal = () => {
    if (!bootShell.isConnected || bootShell.querySelector("#boot-error")) return;
    bootShell.dataset.state = "leaving";
    document.documentElement.dataset.appBooting = "revealing";

    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(fallbackTimer);
      bootShell.removeEventListener("transitionend", onTransitionEnd);
      finish();
    };
    const onTransitionEnd = (event: TransitionEvent) => {
      if (event.target === bootShell && event.propertyName === "opacity") {
        done();
      }
    };
    const fallbackTimer = window.setTimeout(done, REVEAL_CLEANUP_MS);
    bootShell.addEventListener("transitionend", onTransitionEnd);
  };

  void nextPaintedFrame().then(() => {
    if (!bootShell.isConnected || bootShell.querySelector("#boot-error")) return;
    if (bootShell.dataset.visible !== "true") {
      bootShell.dataset.visible = "true";
      window.__ZEROCODE_BOOT_START__ ??= performance.now();
    }
    const startedAt = window.__ZEROCODE_BOOT_START__ ?? performance.now();
    const remaining = Math.max(0, MIN_BOOT_ICON_MS - (performance.now() - startedAt));
    if (remaining === 0) {
      startReveal();
    } else {
      window.setTimeout(startReveal, remaining);
    }
  });
}
