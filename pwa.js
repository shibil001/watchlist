/* Web / phone only. Does nothing inside the desktop app. */
(function () {
  if (window.api) return;                       // desktop app (Electron)
  if (window.Capacitor) return;                 // Android app (files are already on the phone)
  if (!/^https?:$/.test(location.protocol)) return;

  // Updates: the new version is already saved on the device when it takes over, so the next time the app opens it is the new one.
  // The reload below only happens while the app is in the background, so nobody sees a refresh (and a launch never stutters).
  if ("serviceWorker" in navigator) {
    const hadWorker = !!navigator.serviceWorker.controller; // false on the very first visit: nothing to refresh then
    let reloading = false, waiting = false;
    const reloadNow = () => { if (reloading) return; reloading = true; location.reload(); };
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (!hadWorker) return;
      if (document.hidden) reloadNow(); else waiting = true;
    });
    document.addEventListener("visibilitychange", () => { if (document.hidden && waiting) reloadNow(); });
  }

  // Offline support.
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).then((reg) => {
        // A Home Screen app can stay open for days: look for a new version whenever it comes back to the front.
        document.addEventListener("visibilitychange", () => { if (!document.hidden) reg.update().catch(() => {}); });
      }).catch(() => {});
    });
  }

  // Ask the browser to keep the list safe from automatic clean-up.
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {}

  // "Install app" support (Chrome, Edge, Android). iOS uses Share -> Add to Home Screen.
  const standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  window.__installApp = null;
  const changed = () => { try { window.__onInstallChange && window.__onInstallChange(); } catch (e) {} };
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    window.__installApp = async () => {
      e.prompt();
      try { await e.userChoice; } catch (x) {}
      window.__installApp = null;
      changed();
    };
    changed();
  });
  window.addEventListener("appinstalled", () => { window.__installApp = null; changed(); });
  // Phones and tablets only: on a computer people use the Mac / Windows app, so no install prompt is shown there.
  const phone = /android|iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  window.__canInstall = () => phone && !standalone && !!window.__installApp;
  window.__isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  window.__showIOSInstall = () => !standalone && window.__isIOS;
  window.__isStandalone = standalone;
  // Facebook, Instagram, WhatsApp... open pages in their own viewer, which cannot add to the Home Screen.
  window.__iosInApp = /FBAN|FBAV|Instagram|Line\/|MicroMessenger|Snapchat|Twitter|GSA\/|WhatsApp/i.test(navigator.userAgent);
  changed();
})();
