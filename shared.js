// Shared Home Assistant access for the glasses web apps.
// Plain HTTP requests only: the glasses' internet goes through the phone, which can't hold a
// websocket open, but ordinary requests get through fine.
// The access token comes from the app link (…/?token=XXXX) so nothing has to be typed on the glasses.
(function () {
  var HA_URL = "https://g2khwjqw9m6bm8c8ipdy970d7nmv28a1.ui.nabu.casa";
  var KEY = "ha_glasses_llat";

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

  // fetch with a timeout; 401 becomes code "auth", anything network-ish becomes code "offline"
  function rest(method, path, body, timeoutMs) {
    if (!token) return Promise.reject(err("no token", "notoken"));
    var ctl = window.AbortController ? new AbortController() : null;
    var t = setTimeout(function () { if (ctl) ctl.abort(); }, timeoutMs || 15000);
    var opts = { method: method, headers: { "Authorization": "Bearer " + token }, cache: "no-store" };
    if (ctl) opts.signal = ctl.signal;
    if (body !== undefined) { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
    return fetch(HA_URL + path, opts).then(function (r) {
      clearTimeout(t);
      if (r.status === 401) throw err("Home Assistant rejected the access token", "auth");
      return r.text().then(function (txt) {
        var data = null; try { data = txt ? JSON.parse(txt) : null; } catch (e) { data = txt; }
        if (!r.ok) throw err((data && data.message) || ("HTTP " + r.status), r.status);
        return data;
      });
    }, function () { clearTimeout(t); throw err("offline", "offline"); });
  }

  var api = {
    HA_URL: HA_URL,
    token: token,
    rest: rest,
    // entities carrying a HA label: [{entity_id, name, state, access_token?}]
    entities: function (label) { return rest("GET", "/api/glasses/entities?label=" + encodeURIComponent(label)); },
    state: function (entityId) { return rest("GET", "/api/states/" + entityId); },
    // call a service; withResponse returns the service's response data
    service: function (domain, service, data, withResponse) {
      return rest("POST", "/api/services/" + domain + "/" + service + (withResponse ? "?return_response" : ""), data || {}, 30000)
        .then(function (r) { return withResponse ? (r && r.service_response) : r; });
    },
    // start a camera's HLS stream: returns its CORS-enabled playlist URL
    stream: function (entityId) {
      return rest("GET", "/api/glasses/stream?entity_id=" + encodeURIComponent(entityId), undefined, 30000)
        .then(function (r) { return HA_URL + r.url.replace("/api/hls/", "/api/glasses_hls/"); });
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
})();
