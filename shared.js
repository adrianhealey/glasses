// Shared Home Assistant connection for the glasses web apps.
// The access token comes from the app link (…/?token=XXXX) so nothing has to be typed on the glasses.
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

  // Minimal HA WebSocket client with auto-reconnect and a heartbeat, so a link that dies
  // silently (phone switching networks, glasses sleeping) is noticed and replaced.
  function connect(handlers) {
    var token = readToken();
    if (!token) { handlers.noToken(); return null; }
    var ws, id = 1, pending = {}, subs = {}, timer = null, beat = null, lastSeen = 0, authed = false, api = {}, dead = false;
    api.send = function (msg) {
      return new Promise(function (res, rej) {
        if (!ws || ws.readyState !== 1 || !authed) return rej(new Error("offline"));
        var i = id++; pending[i] = { res: res, rej: rej };
        msg.id = i; ws.send(JSON.stringify(msg));
      });
    };
    api.subscribe = function (msg, cb) { var i = id; subs[i] = cb; var p = api.send(msg); p.subId = i; return p; };  // send() uses the current id
    api.unsubscribe = function (subId) { delete subs[subId]; return api.send({ type: "unsubscribe_events", subscription: subId }).catch(function () {}); };

    function drop() {  // abandon the current socket and reconnect straight away
      var old = ws; ws = null; authed = false;
      if (old) { old.onclose = old.onmessage = old.onerror = null; try { old.close(); } catch (e) {} }
      clearInterval(beat);
      for (var k in pending) { try { pending[k].rej(new Error("offline")); } catch (e) {} }
      pending = {};
    }
    function open() {
      if (dead) return;
      clearTimeout(timer); drop();
      handlers.status("Connecting…");
      var sock = ws = new WebSocket(HA_URL.replace(/^http/, "ws") + "/api/websocket");
      var opening = setTimeout(function () { if (ws === sock && !authed) { handlers.status("Offline", true); open(); } }, 12000);
      sock.onmessage = function (ev) {
        lastSeen = Date.now();
        var m = JSON.parse(ev.data);
        if (m.type === "auth_required") sock.send(JSON.stringify({ type: "auth", access_token: token }));
        else if (m.type === "auth_invalid") { clearTimeout(opening); dead = true; try { localStorage.removeItem(KEY); } catch (e) {} drop(); handlers.badToken(); }
        else if (m.type === "auth_ok") {
          clearTimeout(opening); authed = true; id = 1; pending = {}; subs = {};
          clearInterval(beat);
          beat = setInterval(function () {  // HA answers {type:"ping"} with "pong"; no answer in 25 s = dead link
            if (ws !== sock) return;
            if (Date.now() - lastSeen > 25000) { handlers.status("Offline", true); open(); return; }
            try { sock.send(JSON.stringify({ type: "ping", id: id++ })); } catch (e) { open(); }
          }, 10000);
          handlers.ready(api);
        }
        else if (m.type === "result" && pending[m.id]) { (m.success ? pending[m.id].res : pending[m.id].rej)(m.success ? m.result : m.error); delete pending[m.id]; }
        else if (m.type === "event" && subs[m.id]) subs[m.id](m.event);
      };
      sock.onclose = function () {
        clearTimeout(opening);
        if (ws !== sock) return;
        drop(); handlers.status("Offline", true);
        timer = setTimeout(open, 3000);
      };
    }
    api.close = function () { dead = true; clearTimeout(timer); drop(); };
    // Called when the app comes back into view: reconnect now unless the link is open and recently alive.
    api.reopen = function () {
      if (dead) return;
      if (ws && authed && ws.readyState === 1 && Date.now() - lastSeen < 15000) return;
      open();
    };
    api.HA_URL = HA_URL;
    ["online", "focus", "pageshow"].forEach(function (ev) { window.addEventListener(ev, function () { api.reopen(); }); });
    open();
    return api;
  }

  window.GlassesHA = { connect: connect, HA_URL: HA_URL };
})();
