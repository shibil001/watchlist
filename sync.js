/* Optional cloud backup & sync (Supabase). Plain fetch, no libraries, so the same file
   works in the desktop app and in phone wrappers. Nothing here runs unless the person signs in. */
(function () {
  const SESSION_KEY = "watchlist-session-v1";
  const META_KEY = "watchlist-sync-v1";
  const ORDER_ID = "__order__";

  const cfg = () => ({
    url: String(window.SUPABASE_URL || "").trim().replace(/\/+$/, ""),
    key: String(window.SUPABASE_ANON_KEY || "").trim(),
  });
  const configured = () => !!(cfg().url && cfg().key);

  /* ---------- tiny HTTP helper ---------- */
  async function http(method, path, { body, token, headers } = {}) {
    const { url, key } = cfg();
    let res;
    try {
      res = await fetch(url + path, {
        method,
        headers: Object.assign(
          { apikey: key, "Content-Type": "application/json", Authorization: "Bearer " + (token || key) },
          headers || {}
        ),
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      const e = new Error("Offline");
      e.offline = true;
      throw e;
    }
    let data = null;
    try { data = await res.json(); } catch {}
    if (!res.ok) {
      const e = new Error((data && (data.msg || data.message || data.error_description || data.error)) || "HTTP " + res.status);
      e.status = res.status;
      throw e;
    }
    return data;
  }

  /* ---------- email, password and PIN ----------
     The password and the PIN are mixed into one long secret on the device (PBKDF2), so the server
     never receives either of them, and all three are needed to sign in. */
  const normEmail = (e) => String(e || "").trim().toLowerCase();

  function checkEmail(e) {
    if (!e) return "Enter your email address.";
    if (e.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) return "Enter a valid email address.";
    return "";
  }

  const COMMON = ["password", "passw0rd", "qwerty", "letmein", "welcome", "admin", "iloveyou", "monkey", "dragon", "football", "abc123", "123456", "111111", "watchlist", "movie"];
  function passwordRules(pw, email, pin) {
    const name = String(email || "").split("@")[0];
    const low = pw.toLowerCase();
    const hit = COMMON.find((c) => low.includes(c));
    const rules = [
      { text: "At least 10 characters", ok: pw.length >= 10 },
      { text: "A lowercase letter", ok: /[a-z]/.test(pw) },
      { text: "An uppercase letter", ok: /[A-Z]/.test(pw) },
      { text: "A number", ok: /\d/.test(pw) },
      { text: "A symbol, like ! or #", ok: /[^A-Za-z0-9\s]/.test(pw) },
      { text: hit ? `No common words (remove "${hit}")` : "No common words like password or qwerty", ok: !hit },
      { text: "Does not contain your email name", ok: !(name.length >= 3 && low.includes(name)) },
    ];
    if (pin && /^\d{6}$/.test(pin)) rules.push({ text: "Does not contain your PIN", ok: !pw.includes(pin) });
    if (pw.length > 128) rules.push({ text: "At most 128 characters", ok: false });
    return rules;
  }

  const WEAK_PINS = ["112233", "445566", "778899", "159753", "147258", "789456", "696969", "101010", "123321", "246810", "135790"];
  function checkPin(pin) {
    if (!/^\d{6}$/.test(pin)) return "The PIN must be exactly 6 digits.";
    if (/^(\d)\1{5}$/.test(pin)) return "Do not repeat one digit.";
    if ("0123456789".includes(pin) || "9876543210".includes(pin)) return "Do not use a straight run like 123456.";
    if (/^(\d\d)\1\1$/.test(pin) || /^(\d\d\d)\1$/.test(pin) || WEAK_PINS.includes(pin)) return "That PIN is too easy to guess. Pick another.";
    return "";
  }

  async function deriveSecret(email, password, pin) {
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(password + "\u0000" + pin), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt: enc.encode("watchlist:v1:" + email), iterations: 210000 },
      keyMaterial, 256
    );
    let bin = "";
    for (const b of new Uint8Array(bits)) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  /* ---------- session ----------
     In the desktop app the sign-in token is encrypted with the system keychain (Electron safeStorage)
     and kept in a file only this app can read. Elsewhere it falls back to localStorage. */
  let sessCache = null, sessLoaded = false;
  const secureApi = () => !!(window.api && window.api.secretGet && window.api.secretSet);

  function getSession() {
    // Browser / installed web app: always read the saved session. Another tab, or the installed Android app
    // (which shares this storage with Chrome), may have refreshed it, and a refresh token works only once.
    if (!secureApi()) {
      try {
        const raw = localStorage.getItem(SESSION_KEY);
        sessCache = raw ? JSON.parse(raw) : null;
        sessLoaded = true;
        return sessCache;
      } catch { /* storage blocked: fall back to the copy in memory */ }
      return sessCache;
    }
    if (sessLoaded) return sessCache;
    sessLoaded = true;
    let raw = null;
    let secure = false;
    try {
      const r = window.api.secretGet();
      if (r && r.available) { secure = true; raw = r.value || null; }
    } catch {}
    if (secure && !raw) {
      // One-time move of a token saved by an older version in plain localStorage.
      try {
        const old = localStorage.getItem(SESSION_KEY);
        if (old) {
          raw = old;
          if (window.api.secretSet(old)) localStorage.removeItem(SESSION_KEY);
        }
      } catch {}
    } else if (!secure) {
      try { raw = localStorage.getItem(SESSION_KEY); } catch {}
    }
    try { sessCache = raw ? JSON.parse(raw) : null; } catch { sessCache = null; }
    return sessCache;
  }
  function setSession(s) {
    sessCache = s || null;
    sessLoaded = true;
    let stored = false;
    if (secureApi()) {
      try { stored = window.api.secretSet(s ? JSON.stringify(s) : "") === true; } catch {}
    }
    try {
      if (stored) localStorage.removeItem(SESSION_KEY);
      else if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
      else localStorage.removeItem(SESSION_KEY);
    } catch {}
  }
  function toSession(d, email) {
    return {
      access_token: d.access_token,
      refresh_token: d.refresh_token,
      expires_at: Date.now() + (Number(d.expires_in) || 3600) * 1000,
      user: { id: d.user.id, email },
    };
  }

  async function signUp(email, password, pin) {
    const secret = await deriveSecret(email, password, pin);
    let d;
    try {
      d = await http("POST", "/auth/v1/signup", { body: { email, password: secret } });
    } catch (e) {
      if (e.status === 422 || /already/i.test(e.message)) {
        const t = new Error("An account with this email already exists. Sign in instead.");
        t.taken = true;
        throw t;
      }
      if (e.status === 429) throw new Error("Too many attempts. Wait a few minutes and try again.");
      throw e;
    }
    if (d && d.access_token) { const s = toSession(d, email); setSession(s); return s; }
    // No session came back: the email already exists (the project hides that) or email confirmation is switched on.
    const t = new Error("An account with this email may already exist, or email confirmation is switched on in Supabase. Try signing in.");
    t.taken = true;
    throw t;
  }
  async function signIn(email, password, pin) {
    const secret = await deriveSecret(email, password, pin);
    let d;
    try {
      d = await http("POST", "/auth/v1/token?grant_type=password", { body: { email, password: secret } });
    } catch (e) {
      if (e.status === 429) throw new Error("Too many attempts. Wait a few minutes and try again.");
      if (e.status === 400 || e.status === 401 || e.status === 422) {
        const t = new Error("The email, password or PIN is not right."); // never says which one
        t.badLogin = true;
        throw t;
      }
      throw e;
    }
    const s = toSession(d, email);
    setSession(s);
    return s;
  }
  // release: free this device's place in the 3-device limit (best effort) before signing out.
  async function signOut({ release = true } = {}) {
    const s = getSession();
    if (s && release) { try { await removeDevice(deviceId()); } catch {} }
    setSession(null);
    if (s) { try { await http("POST", "/auth/v1/logout?scope=local", { token: s.access_token }); } catch {} }
  }
  let refreshing = null; // one refresh at a time: a refresh token works only once
  async function accessToken() {
    let s = getSession();
    if (!s) { const e = new Error("Not signed in"); e.signedOut = true; throw e; }
    if (s.expires_at - Date.now() < 60000) {
      if (!refreshing) {
        const used = s.refresh_token;
        refreshing = (async () => {
          try {
            const d = await http("POST", "/auth/v1/token?grant_type=refresh_token", { body: { refresh_token: used } });
            const n = toSession(d, s.user.email);
            setSession(n);
            return n;
          } catch (e) {
            // Maybe another tab refreshed first and saved a newer session: use that instead of signing out.
            const again = getSession();
            if (again && again.refresh_token !== used && again.expires_at - Date.now() > 0) return again;
            if (e.status >= 400 && e.status < 500) { setSession(null); e.signedOut = true; }
            throw e;
          } finally { refreshing = null; }
        })();
      }
      s = await refreshing;
    }
    return s.access_token;
  }

  /* ---------- devices: at most 3 per account (enforced by the database) ---------- */
  const DEVICE_KEY = "watchlist-device-v1";
  const DEVICE_MAX = 3;
  function deviceId() {
    let id = "";
    try { id = localStorage.getItem(DEVICE_KEY) || ""; } catch {}
    if (!/^[A-Za-z0-9-]{16,64}$/.test(id)) {
      if (typeof crypto !== "undefined" && crypto.randomUUID) id = crypto.randomUUID();
      else id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
      try { localStorage.setItem(DEVICE_KEY, id); } catch {}
    }
    return id;
  }
  function deviceName() {
    let n = "";
    try { n = window.api && window.api.deviceName ? String(window.api.deviceName() || "") : ""; } catch {}
    if (!n) {
      const ua = (typeof navigator !== "undefined" && navigator.userAgent) || "";
      const ios = /iPhone|iPad/.test(ua);
      const base = ios ? "iPhone or iPad" : /Android/.test(ua) ? "Android" : /Mac/.test(ua) ? "Mac" : /Win/.test(ua) ? "Windows PC" : /Linux/.test(ua) ? "Linux" : "Browser";
      let installed = false;
      try { installed = !!(window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) || navigator.standalone === true; } catch {}
      // So the devices list can tell the browser and the installed app apart.
      n = window.Capacitor ? "Android app" : base + (installed ? (ios ? " (Home Screen app)" : " (installed app)") : " (browser)");
    }
    return n.trim().slice(0, 60) || "Device";
  }
  async function rpc(name, args) {
    const token = await accessToken();
    return http("POST", "/rest/v1/rpc/" + name, { token, body: args || {} });
  }
  async function registerDevice() {
    try { return await rpc("register_device", { p_device_id: deviceId(), p_name: deviceName() }); }
    catch (e) { if (e.status === 404) e.notSetUp = true; throw e; }
  }
  // Anonymous usage count (platform + random device id; the country is read by the server). Never throws.
  async function pingUsage(platform) {
    if (!configured()) return;
    try { await http("POST", "/rest/v1/rpc/ping_usage", { body: { p_device_id: deviceId(), p_platform: platform } }); } catch {}
  }
  const listDevices = () => rpc("list_devices");
  const removeDevice = (id) => rpc("remove_device", { p_device_id: id });
  // true while this session is still a registered device; false once it was removed.
  const touchDevice = () => rpc("touch_device");

  /* ---------- cloud rows ---------- */
  // Start a few seconds before the saved position: a change that was committed a moment late can carry an
  // older timestamp and would otherwise be skipped for good. Merging the same row twice changes nothing.
  function overlap(since) {
    const t = Date.parse(since);
    return Number.isFinite(t) ? new Date(t - 10000).toISOString() : since;
  }
  // since = "" fetches everything; otherwise only rows changed on the server after that moment.
  async function fetchRows(since) {
    const token = await accessToken();
    const out = [];
    const page = 1000;
    for (let offset = 0; ; offset += page) {
      let q = "/rest/v1/watchlist_items?select=item_id,data,updated_at,deleted,synced_at&order=synced_at.asc,item_id.asc&limit=" + page + "&offset=" + offset;
      if (since) q += "&synced_at=gt." + encodeURIComponent(overlap(since));
      const rows = await http("GET", q, { token });
      out.push(...rows);
      if (rows.length < page) break;
    }
    return out;
  }

  // The poster image is a local cache. When we know where it came from (posterPath) it is not uploaded.
  function slim(d) {
    if (!d || typeof d !== "object") return d;
    const o = Object.assign({}, d);
    if (o.posterPath) delete o.poster;
    return o;
  }

  async function pushRows(rows) {
    if (!rows.length) return;
    const token = await accessToken();
    const uid = getSession().user.id;
    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200).map((r) => ({
        user_id: uid,
        item_id: r.item_id,
        data: slim(r.data),
        updated_at: r.updated_at,
        deleted: !!r.deleted,
      }));
      await http("POST", "/rest/v1/watchlist_items?on_conflict=user_id,item_id", {
        token,
        body: chunk,
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      });
    }
  }

  /* ---------- sync bookkeeping (kept small, in localStorage) ---------- */
  const defaultMeta = () => ({ userId: "", enabled: false, cursor: "", tombs: {}, dirty: [], orderTs: 0, orderDirty: false });
  function getMeta() {
    try {
      const m = JSON.parse(localStorage.getItem(META_KEY));
      if (m && typeof m === "object") return Object.assign(defaultMeta(), m);
    } catch {}
    return defaultMeta();
  }
  function setMeta(m) { try { localStorage.setItem(META_KEY, JSON.stringify(m)); } catch {} }

  /* ---------- merge ----------
     state: { items, tombs, dirty, orderTs, orderDirty }
     rows:  cloud rows (everything when full, otherwise only the changes)
     Per title the newest edit wins. A deletion is just a newer edit. Pure: never changes its inputs. */
  function merge(state, rows, full, now = Date.now()) {
    const tombs = Object.assign({}, state.tombs || {});
    const dirty = new Set((state.dirty || []).map(String));
    const cloud = new Map();
    let cloudOrder = null;
    for (const r of rows) {
      if (r.item_id === ORDER_ID) cloudOrder = r;
      else cloud.set(String(r.item_id), r);
    }

    const out = new Map();
    for (const m of state.items) out.set(String(m.id), m);

    // Same title added separately on two devices: keep one copy (the newer edit), under the cloud's id.
    const keyOf = (m) => (m.tmdbId ? (m.type || "movie") + ":" + m.tmdbId : "t:" + String(m.title || "").trim().toLowerCase());
    const cloudByKey = new Map();
    for (const r of cloud.values()) if (!r.deleted && r.data) cloudByKey.set(keyOf(r.data), r);
    const merged = new Set(); // cloud ids that already absorbed a local twin
    for (const [id, m] of [...out]) {
      if (cloud.has(id)) continue;
      const twin = cloudByKey.get(keyOf(m));
      if (!twin || merged.has(String(twin.item_id)) || out.has(String(twin.item_id))) continue;
      merged.add(String(twin.item_id));
      out.delete(id);
      dirty.delete(id);
      if ((m.updatedAt || 0) > (twin.updated_at || 0)) {
        out.set(String(twin.item_id), Object.assign({}, m, { id: Number(twin.item_id) || twin.item_id }));
        dirty.add(String(twin.item_id));
      }
    }

    const push = new Map();
    const liveRow = (m) => ({ item_id: String(m.id), data: m, updated_at: m.updatedAt || 0, deleted: false });
    const delRow = (id, ts) => ({ item_id: String(id), data: {}, updated_at: ts, deleted: true });
    const stats = { pulled: 0, updated: 0, removed: 0, pushed: 0 };

    for (const [id, C] of cloud) {
      if (merged.has(id) && out.has(id)) {
        // handled by the twin rule above (local copy was newer and now owns this id)
        if ((out.get(id).updatedAt || 0) > (C.updated_at || 0)) push.set(id, liveRow(out.get(id)));
        else out.set(id, Object.assign({}, C.data, { updatedAt: C.updated_at || 0 }));
        continue;
      }
      const L = out.get(id);
      const c = C.updated_at || 0;
      const t = tombs[id] || 0;
      if (L) {
        const l = L.updatedAt || 0;
        if (C.deleted) {
          if (l > c) push.set(id, liveRow(L));
          else { out.delete(id); stats.removed++; }
        } else if (l > c) {
          push.set(id, liveRow(L));
        } else if (c > l) {
          out.set(id, Object.assign({}, C.data, { updatedAt: c }));
          dirty.delete(id);
          stats.updated++;
        }
      } else if (C.deleted) {
        delete tombs[id]; // both sides agree it is gone
      } else if (t && t >= c) {
        push.set(id, delRow(id, t)); // deleted here after the cloud copy was last edited
      } else {
        out.set(id, Object.assign({}, C.data, { updatedAt: c }));
        stats.pulled++;
      }
    }

    // Local changes the cloud has not seen yet.
    for (const id of dirty) {
      const L = out.get(id);
      if (L && !cloud.has(id) && !push.has(id)) push.set(id, liveRow(L));
    }
    if (full) {
      for (const [id, L] of out) if (!cloud.has(id) && !push.has(id)) push.set(id, liveRow(L));
    }
    for (const id of Object.keys(tombs)) {
      if (!cloud.has(id) && !out.has(id) && !push.has(id)) push.set(id, delRow(id, tombs[id]));
    }
    // Titles with no timestamp yet (saved before sync existed) get one so they can be compared later.
    for (const [id, r] of push) {
      if (!r.deleted && !r.updated_at) {
        const stamped = Object.assign({}, out.get(id), { updatedAt: now });
        out.set(id, stamped);
        push.set(id, liveRow(stamped));
      }
    }

    // Order: the most recently changed order wins; titles it does not know go to the end.
    let baseOrder = state.items.map((m) => String(m.id));
    let orderTs = state.orderTs || 0;
    let orderPush = !!state.orderDirty;
    if (cloudOrder) {
      const co = cloudOrder.updated_at || 0;
      if (co > orderTs) { baseOrder = (cloudOrder.data && cloudOrder.data.order || []).map(String); orderTs = co; orderPush = false; }
      else if (orderTs > co) orderPush = true;
    } else if (full && out.size) {
      orderPush = true;
    }
    const finalIds = [];
    const placed = new Set();
    for (const id of baseOrder) if (out.has(id) && !placed.has(id)) { finalIds.push(id); placed.add(id); }
    for (const m of state.items) { const id = String(m.id); if (out.has(id) && !placed.has(id)) { finalIds.push(id); placed.add(id); } }
    for (const id of out.keys()) if (!placed.has(id)) { finalIds.push(id); placed.add(id); }
    if (orderPush) {
      const co = cloudOrder ? cloudOrder.updated_at || 0 : 0;
      orderTs = Math.max(orderTs, 1);
      if (orderTs <= co) orderTs = co + 1;
      push.set(ORDER_ID, { item_id: ORDER_ID, data: { order: finalIds }, updated_at: orderTs, deleted: false });
    }

    for (const r of push.values()) if (!r.deleted && r.item_id !== ORDER_ID) stats.pushed++;
    const nextTombs = {};
    for (const [id, ts] of Object.entries(tombs)) if (!out.has(id)) nextTombs[id] = ts;

    return {
      items: finalIds.map((id) => out.get(id)),
      tombs: nextTombs,
      orderTs,
      push: [...push.values()],
      stats,
    };
  }

  window.Sync = {
    ORDER_ID, configured, getSession, signUp, signIn, signOut,
    normEmail, checkEmail, passwordRules, checkPin, deriveSecret,
    fetchRows, pushRows, getMeta, setMeta, defaultMeta, merge, slim,
    clearSession: () => setSession(null),
    DEVICE_MAX, deviceId, deviceName, registerDevice, listDevices, removeDevice, touchDevice, pingUsage,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = window.Sync;
})();
