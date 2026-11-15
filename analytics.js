/* Anonymous usage counters for the admin "Statisztika" page.
   What leaves the device: event names with a short key ("view" + church id, "filter" + "conf"…), added to daily
   counters by the track() database function. No cookies, no visitor id, nothing that links two events together.
   "Visitors per day" works without an id: this device remembers, in its own localStorage, the last day it was
   counted, and sends "visitor" once a day (and "new_visitor" the very first time).
   Nothing is sent when the browser asks not to be tracked (Do Not Track / Global Privacy Control), in automated
   browsers, on a device where the admin page was opened (harangszo.notrack), or without a Supabase configuration. */
(function (w) {
  const CFG = w.HARANGSZO_CONFIG || {}, real = v => v && !/^__.*__$/.test(v);
  const URL_ = real(CFG.supabaseUrl) ? CFG.supabaseUrl.replace(/\/$/, "") : "", KEY = real(CFG.supabaseAnonKey) ? CFG.supabaseAnonKey : "";
  const get = (s, k) => { try { return s.getItem(k); } catch (e) { return null; } };
  const set = (s, k, v) => { try { s.setItem(k, v); return true; } catch (e) { return false; } };
  const store = (() => { try { return w.localStorage; } catch (e) { return null; } })(), session = (() => { try { return w.sessionStorage; } catch (e) { return null; } })();
  const forced = /[?&]track=1\b/.test(location.search); // tests
  const off = !URL_ || !KEY || navigator.doNotTrack === "1" || w.doNotTrack === "1" || navigator.globalPrivacyControl === true
    || (store && get(store, "harangszo.notrack") === "1") || (navigator.webdriver && !forced);
  let queue = [], timer = null, sent = 0;
  const seen = new Set();
  const MAX_PER_PAGE = 300; // a runaway loop can never flood the counters

  function flush() {
    clearTimeout(timer); timer = null;
    if (off || !queue.length) return;
    const batch = queue.splice(0, 30);
    try {
      fetch(URL_ + "/rest/v1/rpc/track", { method: "POST", keepalive: true,
        headers: { apikey: KEY, ...(KEY.startsWith("eyJ") ? { Authorization: "Bearer " + KEY } : {}), "Content-Type": "application/json" },
        body: JSON.stringify({ p: batch }) }).catch(() => { });
    } catch (e) { }
    if (queue.length) timer = setTimeout(flush, 1000);
  }
  // Count an event. The key is optional (a church id, a filter name, a search word).
  function ev(e, k) {
    if (off || sent >= MAX_PER_PAGE) return;
    sent++; queue.push(k == null || k === "" ? { e } : { e, k: String(k) });
    if (!timer) timer = setTimeout(flush, 4000);
  }
  // Count it at most once per page load (opening the same church five times is one view).
  function once(e, k) { const id = e + ":" + (k == null ? "" : k); if (seen.has(id)) return; seen.add(id); ev(e, k); }

  if (!off) {
    // A visit is a browser tab session; reloads in the same tab are not new visits.
    if (!session || get(session, "harangszo.visit") !== "1") {
      if (session) set(session, "harangszo.visit", "1");
      ev("visit");
      const d = new Date(), today = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
      if (store) {
        const last = get(store, "harangszo.seen");
        if (last !== today && set(store, "harangszo.seen", today)) { ev("visitor"); if (!last) ev("new_visitor"); }
      }
      const wide = Math.min(w.innerWidth || 0, w.screen ? w.screen.width : 9999), coarse = w.matchMedia && w.matchMedia("(pointer: coarse)").matches;
      ev("device", wide < 600 ? "phone" : wide < 1100 && coarse ? "tablet" : "desktop");
      const app = (w.matchMedia && w.matchMedia("(display-mode: standalone)").matches) || navigator.standalone === true;
      ev("mode", app ? "app" : "browser");
    }
    w.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flush(); });
  }
  w.Track = { ev, once, flush, off };
})(window);
