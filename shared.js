// Shared Home Assistant access for the glasses web apps.
// Plain HTTP GET requests only: the glasses' internet goes through the phone, which can't hold a
// websocket open, but ordinary requests get through fine.
// The access token comes from the app link (…/?token=XXXX) so nothing has to be typed on the glasses.
//
// v12: Tailscale only (Tailscale Funnel makes homeassistant.tail0892f8.ts.net reachable from anywhere,
//      no Tailscale needed on the phone). Nabu Casa is no longer used.
// v11:
// - "Simple" requests: the token goes in the URL (?t=) instead of an Authorization header, so the
//   browser no longer sends an extra CORS preflight request before every real one (the glasses_hls
//   helper in Home Assistant checks the token itself).
// - Leaving an app cancels every request it has in flight (like Herald's apps do), so nothing is left
//   hanging on the glasses' connection. Coming back carries on; after 45 s away the app restarts fresh.
// - A ✕ button in the header closes the app properly: all requests, video and pictures stop.
(function () {
  var HA_URL = "https://homeassistant.tail0892f8.ts.net";   // Home Assistant via Tailscale Funnel
  var KEY = "ha_glasses_llat", TV_KEY = "glasses_tv_live";
  var AWAY_RESTART = 45000;   // away longer than this: start afresh on return
  try { localStorage.removeItem("ha_glasses_route"); } catch (e) {}
  function base() { return HA_URL; }
  var isTv = /\/tv\//.test(location.pathname);

  function readToken() {
    var m = (location.hash || "").match(/token=([^&]+)/) || (location.search || "").match(/[?&]token=([^&]+)/);
    if (m) {
      var t = decodeURIComponent(m[1]).trim();
      try { localStorage.setItem(KEY, t); } catch (e) {}
      return t;
    }
    try { return localStorage.getItem(KEY); } catch (e) { return null; }
  }
  var token = readToken();
  function withToken(path) { return path + (path.indexOf("?") >= 0 ? "&" : "?") + "t=" + encodeURIComponent(token); }

  function err(msg, code) { var e = new Error(msg); e.code = code; return e; }
  var NEVER = function () { return new Promise(function () {}); };   // a request we dropped on purpose: nothing follows

  // ---- requests in flight, so they can all be cancelled when the app is left or closed ----
  var inflight = [], closed = false, away = false, awaySince = 0;
  function abortAll() {
    var list = inflight; inflight = [];
    list.forEach(function (c) { c.ours = true; try { c.abort(); } catch (e) {} });
  }

  function rest(method, path, body, timeoutMs) {
    if (closed || away) return NEVER();
    return attempt(method, path, body, timeoutMs);
  }

  // fetch with a timeout; 401 becomes code "auth", anything network-ish becomes code "offline"
  function attempt(method, path, body, timeoutMs) {
    if (!token) return Promise.reject(err("no token", "notoken"));
    var ctl = window.AbortController ? new AbortController() : null;
    if (ctl) inflight.push(ctl);
    function done() { if (ctl) { var i = inflight.indexOf(ctl); if (i >= 0) inflight.splice(i, 1); } }
    var t = setTimeout(function () { if (ctl) ctl.abort(); }, timeoutMs || 15000);
    // no custom headers on a GET: a "simple" request, so there's no CORS preflight round trip first
    var opts = { method: method, cache: "no-store", credentials: "omit" };
    if (ctl) opts.signal = ctl.signal;
    if (body !== undefined) { opts.headers = { "Content-Type": "application/json" }; opts.body = JSON.stringify(body); }
    return fetch(HA_URL + withToken(path), opts).then(function (resp) {
      clearTimeout(t); done();
      if (resp.status === 401) throw err("Home Assistant rejected the access token", "auth");
      return resp.text().then(function (txt) {
        var data = null; try { data = txt ? JSON.parse(txt) : null; } catch (e) { data = txt; }
        if (!resp.ok) throw err((data && data.message) || ("HTTP " + resp.status), resp.status);
        return data;
      });
    }, function () {
      clearTimeout(t); done();
      if (ctl && ctl.ours) return NEVER();   // cancelled because the app was left or closed: stay quiet
      var e = err("offline", "offline"); e.why = (ctl && ctl.signal.aborted) ? "no reply in " + Math.round((timeoutMs || 15000) / 1000) + "s" : "connection failed";
      throw e;
    });
  }

  // When offline: is it the glasses' internet, or just the route to Home Assistant?
  function probe(url, ms) {
    var ctl = window.AbortController ? new AbortController() : null, t0 = Date.now();
    var t = setTimeout(function () { if (ctl) ctl.abort(); }, ms);
    return fetch(url, { mode: "no-cors", cache: "no-store", signal: ctl ? ctl.signal : undefined })
      .then(function () { clearTimeout(t); return "ok " + (Date.now() - t0) + "ms"; },
            function () { clearTimeout(t); return (ctl && ctl.signal.aborted) ? "no reply" : "failed"; });
  }
  function diagnose(e) {
    return Promise.all([probe("https://www.google.com/generate_204?x=" + Date.now(), 8000),
                        probe(HA_URL + "/manifest.json?x=" + Date.now(), 12000)]).then(function (r) {
      return "Internet: " + r[0] + " · Home Assistant: " + r[1] + (e && e.why ? " · last: " + e.why : "") +
        " · " + new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    });
  }

  // fire-and-forget request that survives the page closing (TV stop)
  function beacon(path) {
    if (!token) return;
    try { fetch(base() + withToken(path), { keepalive: true, cache: "no-store", credentials: "omit" }).catch(function () {}); } catch (e) {}
  }
  function tvLive(on) { try { if (on) localStorage.setItem(TV_KEY, String(Date.now())); else localStorage.removeItem(TV_KEY); } catch (e) {} }
  function tvWasLive() { try { return !!localStorage.getItem(TV_KEY); } catch (e) { return false; } }

  var api = {
    HA_URL: HA_URL,
    base: base,                                   // the route currently in use (for picture and video links)
    otherRoute: function () { return base(); },   // single route now (kept so older app code still works)
    routeName: function () { return "Tailscale"; },
    token: token,
    rest: rest,
    diagnose: diagnose,
    // entities carrying a HA label: [{entity_id, name, state, access_token?}]
    entities: function (label) { return rest("GET", "/api/glasses/entities?label=" + encodeURIComponent(label)); },
    // call a service; withResponse returns the service's response data (a GET to the glasses_hls helper)
    service: function (domain, service, data, withResponse) {
      return rest("GET", "/api/glasses/call?domain=" + encodeURIComponent(domain) + "&service=" + encodeURIComponent(service) +
        "&data=" + encodeURIComponent(JSON.stringify(data || {})) + (withResponse ? "&response=1" : ""), undefined, 30000)
        .then(function (r) { return r && r.service_response; });
    },
    // start a camera's HLS stream: returns its CORS-enabled playlist URL
    stream: function (entityId) {
      return rest("GET", "/api/glasses/stream?entity_id=" + encodeURIComponent(entityId), undefined, 30000)
        .then(function (r) { tvLive(true); return base() + r.url.replace("/api/hls/", "/api/glasses_hls/"); });
    },
    // stop a channel's stream so its IPTV connection closes straight away
    stopStream: function (entityId) {
      if (!entityId) return;
      tvLive(false);
      beacon("/api/glasses/stream?stop=1&entity_id=" + encodeURIComponent(entityId));
    },
    // stop every TV channel: a TV app left playing in the background would hog the glasses' connection
    tvOff: function () { tvLive(false); beacon("/api/glasses/stream?all_off=1"); },
    // when offline, show why in el (at most every 20 s)
    explain: function (e, el, isOffline) {
      var now = Date.now();
      if (closed || away || (api._diagAt && now - api._diagAt < 20000)) return;
      api._diagAt = now;
      diagnose(e).then(function (d) { if (isOffline()) { el.hidden = false; el.innerHTML = '<span style="font-size:17px">' + d + '</span>'; } });
    },
    // standard handling of a failed request: returns the status text to show
    describe: function (e, h) {
      if (e && e.code === "auth") { h.badToken(); return null; }
      if (e && e.code === "notoken") { h.noToken(); return null; }
      if (e && e.code === "offline") return "Offline";
      return "Error";
    },
    close: closeApp
  };
  window.GlassesHA = api;

  // ---- TV running in the background ----
  // Tell a TV app still running on the glasses to stop, directly (no network needed): a TV app left
  // streaming in the background uses up the glasses' connection so nothing else gets through.
  function tvOffLocal() {
    try { new BroadcastChannel("glasses").postMessage({ type: "tv-off" }); } catch (e) {}
    try { localStorage.setItem("glasses_tv_off", String(Date.now())); } catch (e) {}
  }
  api.onTvOff = function (cb) {
    try { new BroadcastChannel("glasses").onmessage = function (ev) { if (ev.data && ev.data.type === "tv-off") cb(); }; } catch (e) {}
    window.addEventListener("storage", function (ev) { if (ev.key === "glasses_tv_off") cb(); });
  };
  function tvCheck() { if (isTv) return; tvOffLocal(); if (tvWasLive()) api.tvOff(); }   // network only if TV was actually playing
  tvCheck();

  // ---- leaving and coming back (the glasses often keep a left app running) ----
  var awayTimer = null;
  function leave() {
    if (closed || away) return;
    away = true; awaySince = Date.now();
    abortAll();
  }
  function back() {
    if (closed) return;
    clearTimeout(awayTimer);
    if (!away) return;
    var gone = Date.now() - awaySince;
    away = false;
    if (gone > AWAY_RESTART) { location.reload(); return; }   // been a while: start afresh rather than resume half-finished work
    tvCheck();
    // let the app pick up where it left off (apps refresh on visibilitychange)
    try { document.dispatchEvent(new Event("visibilitychange")); } catch (e) {}
  }
  document.addEventListener("visibilitychange", function () { if (document.hidden) leave(); else back(); }, true);
  window.addEventListener("pagehide", leave, true);
  document.addEventListener("freeze", leave, true);
  window.addEventListener("pageshow", function (e) { if (e.persisted) { away = true; awaySince = 0; back(); } });
  // blur: the app may stay visible behind the glasses' menu; give it a moment (a dialog can blur briefly)
  window.addEventListener("blur", function () { clearTimeout(awayTimer); awayTimer = setTimeout(function () { if (!document.hasFocus()) leave(); }, 1500); });
  window.addEventListener("focus", back);

  // ---- ✕ Close: stop everything the app is doing ----
  function closeApp() {
    if (closed) return;
    // let the app run its own clean-up (TV stops its stream, Front Door stops pictures, polling stops)
    try { window.dispatchEvent(new Event("blur")); } catch (e) {}
    try { window.dispatchEvent(new Event("pagehide")); } catch (e) {}
    closed = true; abortAll();
    if (isTv || tvWasLive()) api.tvOff();
    [].forEach.call(document.querySelectorAll("video"), function (v) { try { v.pause(); v.removeAttribute("src"); v.load(); } catch (e) {} });
    [].forEach.call(document.querySelectorAll("img"), function (i) { try { i.removeAttribute("src"); } catch (e) {} });
    [].forEach.call(document.body.children, function (c) { if (c.tagName !== "SCRIPT") c.style.display = "none"; });
    var p = document.createElement("div");
    p.setAttribute("style", "display:flex;flex-direction:column;align-items:center;justify-content:center;gap:22px;height:100%;padding:20px;text-align:center");
    p.innerHTML = '<div style="font-size:26px;font-weight:600">' + (document.title || "App") + ' closed</div>' +
      '<div style="font-size:19px;color:#8a8a8a">Nothing is running or connecting.</div>' +
      '<button id="gx-reopen" style="font:inherit;font-size:24px;color:#fff;background:#141414;border:3px solid #5ad1ff;border-radius:16px;padding:14px 28px">Open again</button>';
    document.body.appendChild(p);
    document.getElementById("gx-reopen").addEventListener("click", function () { location.reload(); });
    document.getElementById("gx-reopen").focus();
    try { window.close(); } catch (e) {}
  }
  function addCloseButton() {
    var h = document.querySelector("header");
    if (!h || document.getElementById("gx-close")) return;
    var css = document.createElement("style");
    css.textContent = "#gx-close{flex:none;margin-left:12px;font:inherit;font-size:20px;line-height:1;color:#bbb;background:#1a1a1a;border:3px solid transparent;border-radius:12px;padding:6px 12px}" +
      "#gx-close:focus{outline:none;border-color:#5ad1ff;color:#fff}header>#status{margin-left:auto}";
    document.head.appendChild(css);
    var b = document.createElement("button");
    b.id = "gx-close"; b.textContent = "✕"; b.setAttribute("aria-label", "Close app");
    b.addEventListener("click", closeApp);
    h.appendChild(b);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", addCloseButton); else addCloseButton();
})();
