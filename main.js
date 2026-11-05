const { app, BrowserWindow, globalShortcut, ipcMain, shell, nativeTheme, screen, safeStorage } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");

// The app used to be called "Movie Watchlist". Keep using that data folder if it exists,
// so a list saved before the rename is not lost.
const legacyData = path.join(app.getPath("appData"), "Movie Watchlist");
if (fs.existsSync(legacyData)) app.setPath("userData", legacyData);

let win = null;

// Only one copy of the app at a time. Two copies would overwrite each other's watchlist.json.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
app.on("second-instance", () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

const bg = () => (nativeTheme.shouldUseDarkColors ? "#121212" : "#ffffff");

// Open like a normal Mac app: a wide window, about three quarters of the screen width, centred.
function initialSize() {
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const width = Math.min(workArea.width, Math.max(820, Math.min(1400, Math.round(workArea.width * 0.75))));
  const height = Math.min(workArea.height, Math.max(600, Math.min(940, Math.round(workArea.height * 0.88))));
  return { width, height };
}

function createWindow() {
  const size = initialSize();
  win = new BrowserWindow({
    title: "Watchlist",
    width: size.width,
    height: size.height,
    center: true,
    minWidth: 320,
    minHeight: 480,
    autoHideMenuBar: true, // Windows/Linux: no menu bar, so the window looks the same as on Mac
    show: false, // shown once painted, so there is no wrong-colour flash
    ...(process.platform === "darwin" ? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 18, y: 18 } } : {}),
    backgroundColor: bg(),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Never let the app window navigate away or open new windows.
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e) => e.preventDefault());

  win.once("ready-to-show", () => win.show());
  win.loadFile("index.html");
  win.on("closed", () => { win = null; });
}

function toggleWindow() {
  if (!win) return createWindow();
  if (win.isVisible() && win.isFocused()) win.hide();
  else { win.show(); win.focus(); }
}

// Keep the window background in step with the theme (avoids a flash on resize).
nativeTheme.on("updated", () => { if (win) win.setBackgroundColor(bg()); });

// ---- sign-in token, encrypted with the system keychain (safeStorage) ----
// Only the app's own window may ask. If encryption is not available the page falls back to its own storage.
const fromApp = (e) => !!win && e.sender === win.webContents;
const secretFile = () => path.join(app.getPath("userData"), "session.bin");

ipcMain.on("secret-get", (e) => {
  e.returnValue = { available: false, value: "" };
  if (!fromApp(e)) return;
  try {
    if (!safeStorage.isEncryptionAvailable()) return;
    let value = "";
    try { value = safeStorage.decryptString(fs.readFileSync(secretFile())); } catch {}
    e.returnValue = { available: true, value };
  } catch {}
});

ipcMain.on("secret-set", (e, value) => {
  e.returnValue = false;
  if (!fromApp(e)) return;
  try {
    if (!safeStorage.isEncryptionAvailable()) return;
    const v = typeof value === "string" ? value : "";
    if (!v) { fs.rmSync(secretFile(), { force: true }); e.returnValue = true; return; }
    if (v.length > 20000) return;
    fs.mkdirSync(path.dirname(secretFile()), { recursive: true });
    fs.writeFileSync(secretFile(), safeStorage.encryptString(v), { mode: 0o600 });
    e.returnValue = true;
  } catch {}
});

// The computer's name, shown in the device list (for example "Shibil's MacBook").
ipcMain.on("device-name", (e) => {
  e.returnValue = fromApp(e) ? String(os.hostname() || "").replace(/\.local$/i, "").slice(0, 60) : "";
});

ipcMain.handle("set-pin", (_e, on) => {
  if (!win) return false;
  win.setAlwaysOnTop(!!on, "floating");
  return win.isAlwaysOnTop();
});

// "light" | "dark" | "system". The page's CSS follows prefers-color-scheme.
ipcMain.handle("set-theme", (_e, theme) => {
  if (["light", "dark", "system"].includes(theme)) nativeTheme.themeSource = theme;
});

// ---- List storage: a regular file, so there is no size limit and it is easy to back up. ----
// Lives in the app's data folder: ~/Library/Application Support/Watchlist/watchlist.json
const listFile = () => path.join(app.getPath("userData"), "watchlist.json");

// Returns { exists, items }. Used once at start-up by the page.
ipcMain.on("list-load", (e) => {
  try {
    const raw = fs.readFileSync(listFile(), "utf8");
    const items = JSON.parse(raw);
    e.returnValue = { exists: true, items: Array.isArray(items) ? items : [] };
  } catch (err) {
    // No file yet (first run) or unreadable. If it is unreadable, try the last backup.
    try {
      const items = JSON.parse(fs.readFileSync(listFile() + ".bak", "utf8"));
      if (Array.isArray(items)) return (e.returnValue = { exists: true, items });
    } catch (e2) {}
    e.returnValue = { exists: false, items: [] };
  }
});

// Safe write: write to a temp file, keep the previous copy as .bak, then swap it in.
ipcMain.on("list-save", (e, json) => {
  try {
    const file = listFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, String(json), "utf8");
    // Only a file that still reads as a valid list becomes the backup, so one bad save can never replace the good copy.
    if (fs.existsSync(file)) {
      try {
        if (Array.isArray(JSON.parse(fs.readFileSync(file, "utf8")))) fs.copyFileSync(file, file + ".bak");
      } catch { /* current file is damaged: keep the older backup */ }
    }
    fs.renameSync(tmp, file);
    e.returnValue = { ok: true, bytes: Buffer.byteLength(String(json)) };
  } catch (err) {
    e.returnValue = { ok: false, error: String(err && err.message || err) };
  }
});

ipcMain.handle("list-reveal", () => {
  const file = listFile();
  if (fs.existsSync(file)) shell.showItemInFolder(file);
  else shell.openPath(path.dirname(file));
});

// Only allow a few known links to open outside the app.
const ALLOWED_LINKS = [
  (u) => u.protocol === "https:" && (u.hostname === "themoviedb.org" || u.hostname.endsWith(".themoviedb.org")),
  (u) => u.protocol === "https:" && u.hostname === "github.com" && (u.pathname === "/shibil001" || u.pathname.startsWith("/shibil001/")),
  (u) => u.protocol === "https:" && (u.hostname === "buymeacoffee.com" || u.hostname === "www.buymeacoffee.com") && (u.pathname === "/shibilrahman" || u.pathname.startsWith("/shibilrahman/")),
  (u) => u.protocol === "mailto:" && u.pathname === "kelkacommunity@gmail.com",
];
ipcMain.handle("open-external", (_e, url) => {
  try {
    const u = new URL(url);
    if (ALLOWED_LINKS.some((ok) => ok(u))) return shell.openExternal(u.toString());
  } catch (e) {}
});

app.whenReady().then(() => {
  if (!gotLock) return;
  if (process.platform === "win32") app.setAppUserModelId("com.kind.moviewatchlist");
  // When running with "npm start" show the logo in the Dock too (the built app already has it).
  if (process.platform === "darwin" && app.dock && !app.isPackaged) {
    try { app.dock.setIcon(path.join(__dirname, "build", "icon.png")); } catch (e) {}
  }
  createWindow();
  // Quick open/hide from anywhere: Cmd/Ctrl + Shift + M
  globalShortcut.register("CommandOrControl+Shift+M", toggleWindow);

  app.on("activate", () => {
    if (!win) createWindow();
    else win.show();
  });
});

app.on("will-quit", () => globalShortcut.unregisterAll());

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
