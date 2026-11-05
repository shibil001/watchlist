/* Where the installers live (GitHub Release v1). To ship a new version, upload the new files to a new
   release and update these links (and the matching href values in index.html, which keep the buttons working
   when JavaScript is off). Leave android empty if there is no APK: the button is then hidden. */
var LINKS = {
  mac: "https://github.com/shibil001/watchlist/releases/download/v1/Watchlist-mac.dmg",
  win: "https://github.com/shibil001/watchlist/releases/download/v1/Watchlist-Portable.exe",
  android: "https://github.com/shibil001/watchlist/releases/download/v1/watchlist-Android.apk"
};

(function () {
  var ua = navigator.userAgent || "";
  var plat = navigator.platform || "";
  var hasAndroid = !!LINKS.android;
  var iOS = /iphone|ipad|ipod/i.test(ua) || (plat === "MacIntel" && navigator.maxTouchPoints > 1);
  var droid = /android/i.test(ua);
  var os = droid && hasAndroid ? "android"
    : droid || iOS ? "web"                                  // iPhone / iPad, or Android without an APK: use it online
    : /windows|win32|win64/i.test(ua + " " + plat) ? "win"
    : "mac";
  var ids = { mac: "dlMac", win: "dlWin", android: "dlAndroid", web: "useWeb" };       // "Use online" lives in the top bar only
  function el(id) { return document.getElementById(id); }

  el("dlMac").href = LINKS.mac;
  el("dlWin").href = LINKS.win;
  var a = el("dlAndroid");
  if (hasAndroid) a.href = LINKS.android; else if (a.parentNode) a.parentNode.removeChild(a);

  // A phone has no use for the computer buttons, and iPhone (or Android without an APK) cannot install the Android file.
  function drop(id) { var b = el(id); if (b && b.parentNode) b.parentNode.removeChild(b); }
  if (os === "web") {
    drop("dlWin"); drop("dlAndroid");
    var m = el("dlMac");                                     // reuse this button as "open the app"
    if (m) { m.href = "web/"; m.textContent = "Open the app"; m.id = "dlWeb"; m.classList.add("rec"); }
    var note = document.querySelector(".soon");
    if (note && iOS) note.textContent = "On iPhone: open the app, tap Share, then Add to Home Screen. It installs like a normal app and works offline.";
  } else if (os === "android") {
    drop("dlMac"); drop("dlWin");
  }
  // The best match goes first and is filled in.
  var best = el(ids[os]);
  if (best) best.classList.add("rec");
  // On iPhone nothing is left in the row of download buttons: remove the empty row.
  var row = document.querySelector(".dl");
  if (row && !row.children.length) row.parentNode.removeChild(row);
})();
