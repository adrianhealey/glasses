// Shared Home Assistant access for the glasses web apps.
// Plain HTTP requests only: the glasses' internet goes through the phone, which can't hold a
// websocket open, but ordinary requests get through fine.
// The access token comes from the app link (…/?token=XXXX) so nothing has to be typed on the glasses.
(function () {
  var HA_URL = "https://g2khwjqw9m6bm8c8ipdy970d7nmv28a1.ui.nabu.casa";   // Nabu Casa remote access
  var TS_URL = "https://homeassistant.tail0892f8.ts.net";                   // Tailscale (needs Tailscale on the phone)
  var URLS = [HA_URL, TS_URL], NAMES = ["Nabu Casa", "Tailscale"];
  var KEY = "ha_glasses_llat", BASE_KEY = "ha_glasses_route";
  var route = 0;
  try { route = parseInt(localStorage.getItem(BASE_KEY) || "0", 10) === 1 ? 1 : 0; } catch (e) {}
  function base() { return URLS[route]; }

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

  function err(msg, code) { var e = new Error(msg); e.code = code; return e; }

  // Try the route that last worked; if it doesn't answer, try the other one and remember whichever works.
  function rest(method, path, body, timeoutMs) {
    var first = route;
    return attempt(first, method, path, body, timeoutMs).catch(function (e) {
      if (!e || e.code !== "offline") throw e;
      var other = 1 - first;
      return attempt(other, method, path, body, timeoutMs).then(function (r) {
        route = other; try { localStorage.setItem(BASE_KEY, String(other)); } catch (x) {}
        return r;
      }, function (e2) { e2.why = NAMES[first] + ": " + (e.why || "failed") + ", " + NAMES[other] + ": " + (e2.why || "failed"); throw e2; });
    });
  }

  // fetch with a timeout; 401 becomes code "auth", anything network-ish becomes code "offline"
  function attempt(r, method, path, body, timeoutMs) {
    if (!token) return Promise.reject(err("no token", "notoken"));
    var ctl = window.AbortController ? new AbortController() : null;
    var t = setTimeout(function () { if (ctl) ctl.abort(); }, timeoutMs || 15000);
    var opts = { method: method, headers: { "Authorization": "Bearer " + token }, cache: "no-store" };
    if (ctl) opts.signal = ctl.signal;
    if (body !== undefined) { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
    return fetch(URLS[r] + path, opts).then(function (r) {
      clearTimeout(t);
      if (r.status === 401) throw err("Home Assistant rejected the access token", "auth");
      return r.text().then(function (txt) {
        var data = null; try { data = txt ? JSON.parse(txt) : null; } catch (e) { data = txt; }
        if (!r.ok) throw err((data && data.message) || ("HTTP " + r.status), r.status);
        return data;
      });
    }, function () { clearTimeout(t); var e = err("offline", "offline"); e.why = (ctl && ctl.signal.aborted) ? "no reply in " + Math.round((timeoutMs || 15000) / 1000) + "s" : "connection failed"; throw e; });
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
                        probe(HA_URL + "/manifest.json?x=" + Date.now(), 12000),
                        probe(TS_URL + "/manifest.json?x=" + Date.now(), 12000)]).then(function (r) {
      return "Internet: " + r[0] + " · Nabu Casa: " + r[1] + " · Tailscale: " + r[2] + (e && e.why ? " · last: " + e.why : "") +
        " · " + new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    });
  }

  var api = {
    HA_URL: HA_URL,
    base: base,                                   // the route currently in use (for picture and video links)
    // pictures/video failing on this route: switch to the other one (and remember it)
    otherRoute: function () { route = 1 - route; try { localStorage.setItem(BASE_KEY, String(route)); } catch (x) {} return base(); },
    routeName: function () { return NAMES[route]; },
    token: token,
    rest: rest,
    diagnose: diagnose,
    // entities carrying a HA label: [{entity_id, name, state, access_token?}]
    entities: function (label) { return rest("GET", "/api/glasses/entities?label=" + encodeURIComponent(label)); },
    state: function (entityId) { return rest("GET", "/api/states/" + entityId); },
    // call a service; withResponse returns the service's response data.
    // A GET (to the glasses_hls helper): the glasses' connection through the phone doesn't reliably carry POSTs.
    service: function (domain, service, data, withResponse) {
      return rest("GET", "/api/glasses/call?domain=" + encodeURIComponent(domain) + "&service=" + encodeURIComponent(service) +
        "&data=" + encodeURIComponent(JSON.stringify(data || {})) + (withResponse ? "&response=1" : ""), undefined, 30000)
        .then(function (r) { return r && r.service_response; });
    },
    // start a camera's HLS stream: returns its CORS-enabled playlist URL
    stream: function (entityId) {
      return rest("GET", "/api/glasses/stream?entity_id=" + encodeURIComponent(entityId), undefined, 30000)
        .then(function (r) { return base() + r.url.replace("/api/hls/", "/api/glasses_hls/"); });
    },
    // stop a channel's stream so its IPTV connection closes straight away (keepalive: survives the page closing)
    stopStream: function (entityId) {
      if (!token || !entityId) return;
      try {
        fetch(base() + "/api/glasses/stream?stop=1&entity_id=" + encodeURIComponent(entityId),
          { headers: { "Authorization": "Bearer " + token }, keepalive: true, cache: "no-store" }).catch(function () {});
      } catch (e) {}
    },
    // stop every TV channel: a TV app left playing in the background would hog the glasses' connection
    tvOff: function () {
      if (!token) return;
      try { fetch(base() + "/api/glasses/stream?all_off=1", { headers: { "Authorization": "Bearer " + token }, keepalive: true, cache: "no-store" }).catch(function () {}); } catch (e) {}
    },
    // when offline, show why in el (at most every 20 s)
    explain: function (e, el, isOffline) {
      var now = Date.now();
      if (api._diagAt && now - api._diagAt < 20000) return;
      api._diagAt = now;
      diagnose(e).then(function (d) { if (isOffline()) { el.hidden = false; el.innerHTML = '<span style="font-size:17px">' + d + '</span>'; } });
    },
    // standard handling of a failed request: returns the status text to show
    describe: function (e, h) {
      if (e && e.code === "auth") { h.badToken(); return null; }
      if (e && e.code === "notoken") { h.noToken(); return null; }
      if (e && e.code === "offline") return "Offline";
      return "Error";
    }
  };
  window.GlassesHA = api;
  // any app other than TV: switch off a TV channel that may still be streaming in the background
  // Also tell a TV app still running on the glasses to stop, directly (no network needed): a TV app left
  // streaming in the background uses up the glasses' connection so nothing else gets through.
  function tvOffLocal() {
    try { new BroadcastChannel("glasses").postMessage({ type: "tv-off" }); } catch (e) {}
    try { localStorage.setItem("glasses_tv_off", String(Date.now())); } catch (e) {}
  }
  api.onTvOff = function (cb) {
    try { new BroadcastChannel("glasses").onmessage = function (ev) { if (ev.data && ev.data.type === "tv-off") cb(); }; } catch (e) {}
    window.addEventListener("storage", function (ev) { if (ev.key === "glasses_tv_off") cb(); });
  };
  if (!/\/tv\//.test(location.pathname)) {
    tvOffLocal(); api.tvOff();
    document.addEventListener("visibilitychange", function () { if (!document.hidden) { tvOffLocal(); api.tvOff(); } });
    window.addEventListener("focus", tvOffLocal);
  }
})();
