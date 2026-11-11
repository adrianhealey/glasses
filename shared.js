// Shared Home Assistant connection for the glasses web apps.
// The access token comes from the app link (…/#token=XXXX) so nothing has to be typed on the glasses.
(function () {
  var HA_URL = "https://g2khwjqw9m6bm8c8ipdy970d7nmv28a1.ui.nabu.casa";
  var KEY = "ha_glasses_llat";

  function readToken() {
    var m = (location.hash || "").match(/token=([^&]+)/) || (location.search || "").match(/[?&]token=([^&]+)/);
    if (m) {
      var t = decodeURIComponent(m[1]).trim();
      try { localStorage.setItem(KEY, t); } catch (e) {}
      // keep the token out of the visible address once stored
      try { if (location.hash) history.replaceState(null, "", location.pathname + location.search.replace(/[?&]token=[^&]+/, "")); } catch (e) {}
      return t;
    }
    try { return localStorage.getItem(KEY); } catch (e) { return null; }
  }

  // Minimal HA WebSocket client with auto-reconnect.
  function connect(handlers) {
    var token = readToken();
    if (!token) { handlers.noToken(); return null; }
    var ws, id = 1, pending = {}, subs = {}, timer = null, api = {};
    api.send = function (msg) {
      return new Promise(function (res, rej) {
        if (!ws || ws.readyState !== 1) return rej(new Error("offline"));
        var i = id++; pending[i] = { res: res, rej: rej };
        msg.id = i; ws.send(JSON.stringify(msg));
      });
    };
    api.subscribe = function (msg, cb) { var i = id; subs[i] = cb; var p = api.send(msg); p.subId = i; return p; };  // send() uses the current id
    api.unsubscribe = function (subId) { delete subs[subId]; return api.send({ type: "unsubscribe_events", subscription: subId }).catch(function () {}); };
    function open() {
      clearTimeout(timer);
      handlers.status("Connecting…");
      ws = new WebSocket(HA_URL.replace(/^http/, "ws") + "/api/websocket");
      ws.onmessage = function (ev) {
        var m = JSON.parse(ev.data);
        if (m.type === "auth_required") ws.send(JSON.stringify({ type: "auth", access_token: token }));
        else if (m.type === "auth_invalid") { try { localStorage.removeItem(KEY); } catch (e) {} handlers.badToken(); ws.onclose = null; ws.close(); }
        else if (m.type === "auth_ok") { id = 1; pending = {}; subs = {}; handlers.ready(api); }
        else if (m.type === "result" && pending[m.id]) { (m.success ? pending[m.id].res : pending[m.id].rej)(m.success ? m.result : m.error); delete pending[m.id]; }
        else if (m.type === "event" && subs[m.id]) subs[m.id](m.event);
      };
      ws.onclose = function () { handlers.status("Offline", true); timer = setTimeout(open, 5000); };
    }
    api.close = function () { clearTimeout(timer); if (ws) { ws.onclose = null; ws.close(); } };
    api.reopen = function () { if (!ws || ws.readyState > 1) open(); };
    api.HA_URL = HA_URL;
    open();
    return api;
  }

  window.GlassesHA = { connect: connect, HA_URL: HA_URL };
})();
