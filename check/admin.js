(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var creds = null, timer = null, busy = false;

  var names = null;
  try { names = new Intl.DisplayNames(["en"], { type: "region" }); } catch (e) {}
  function countryLabel(code) {
    if (!/^[A-Z]{2}$/.test(code)) return "Unknown";
    var flag = String.fromCodePoint(code.charCodeAt(0) + 127397, code.charCodeAt(1) + 127397);
    var name = code; try { name = (names && names.of(code)) || code; } catch (e) {}
    return flag + " " + name;
  }

  async function call() {
    var url = String(window.SUPABASE_URL || "").replace(/\/+$/, "");
    var key = String(window.SUPABASE_ANON_KEY || "");
    if (!url || !key) throw new Error("config.js has no Supabase address.");
    var res;
    try {
      res = await fetch(url + "/rest/v1/rpc/admin_stats", {
        method: "POST",
        headers: { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json" },
        body: JSON.stringify({ p_user: creds.u, p_password: creds.p, p_pin: creds.n })
      });
    } catch (e) { throw new Error("No internet connection."); }
    var data = null; try { data = await res.json(); } catch (e) {}
    if (!res.ok) throw new Error((data && data.message) || "Could not load (" + res.status + ").");
    if (data && data.error) throw new Error(data.error);
    return data;
  }

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

  function list(box, rows, labelOf) {
    box.textContent = "";
    if (!rows.length) { box.appendChild(el("div", "empty", "Nothing yet")); return; }
    var max = Math.max.apply(null, rows.map(function (r) { return r.total; })) || 1;
    rows.forEach(function (r) {
      var row = el("div", "row");
      row.appendChild(el("div", "", labelOf(r)));
      var n = el("div", "n", String(r.total));
      if (r.live > 0) n.appendChild(el("span", "l", r.live + " live"));
      row.appendChild(n);
      var bar = el("div", "bar"), fill = el("i"); fill.style.width = Math.max(3, Math.round(r.total / max * 100)) + "%";
      bar.appendChild(fill); row.appendChild(bar); box.appendChild(row);
    });
  }

  function daily(box, rows) {
    box.textContent = "";
    var map = {}; rows.forEach(function (r) { map[r.day] = r.total; });
    var days = [], now = new Date();
    for (var i = 13; i >= 0; i--) { var d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i)); days.push(d.toISOString().slice(0, 10)); }
    var max = Math.max.apply(null, days.map(function (d) { return map[d] || 0; })) || 1;
    days.forEach(function (d) {
      var v = map[d] || 0, col = el("div"), bar = el("i");
      bar.style.height = Math.round(v / max * 80) + "px";
      col.appendChild(el("span", "", v ? String(v) : "")); col.appendChild(bar); col.appendChild(el("span", "", d.slice(8)));
      box.appendChild(col);
    });
  }

  function show(d) {
    $("accounts").textContent = d.accounts; $("live").textContent = d.live; $("total").textContent = d.total; $("day").textContent = d.day;
    $("week").textContent = d.week; $("month").textContent = d.month; $("new").textContent = d.new_today;
    list($("platforms"), d.platforms, function (r) { return r.platform; });
    list($("countries"), d.countries, function (r) { return countryLabel(r.country); });
    daily($("daily"), d.daily_new);
    $("stamp").textContent = "Updated " + new Date().toLocaleTimeString();
  }

  async function refresh(first) {
    if (busy || !creds) return; busy = true;
    try { show(await call()); if (first) { $("login").hidden = true; $("dash").hidden = false; } $("err").textContent = ""; }
    catch (e) {
      if (first) { creds = null; $("err").textContent = e.message; }
      else if (/wrong|too many/i.test(e.message)) { lock(e.message); }
      else $("stamp").textContent = e.message;
    } finally { busy = false; $("go").disabled = false; }
  }

  function lock(msg) {
    clearInterval(timer); timer = null; creds = null;
    $("p").value = ""; $("n").value = ""; $("dash").hidden = true; $("login").hidden = false; $("err").textContent = msg || "";
  }

  $("go").addEventListener("click", function () {
    var u = $("u").value.trim(), p = $("p").value, n = $("n").value.trim();
    if (!u || !p || !/^\d{6}$/.test(n)) { $("err").textContent = "Enter the username, password and 6-digit PIN."; return; }
    creds = { u: u, p: p, n: n }; $("go").disabled = true; $("err").textContent = "";
    $("p").value = ""; $("n").value = "";
    refresh(true).then(function () { if (creds && !timer) timer = setInterval(function () { if (!document.hidden) refresh(false); }, 15000); });
  });
  ["u", "p", "n"].forEach(function (id) { $(id).addEventListener("keydown", function (e) { if (e.key === "Enter") $("go").click(); }); });
  $("out").addEventListener("click", function () { lock(""); });
  document.addEventListener("visibilitychange", function () { if (!document.hidden) refresh(false); });
})();
