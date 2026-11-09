// Fakes the Supabase backend for Playwright tests: config.js, auth, PostgREST tables and RPCs.
//   const { calls } = await mockSupabase(page, { user, staff, tables: { churches: [c] }, rpc: { save_church: b => 1043 } });
// - user:   auth user object; null/undefined = signed out (GET /auth/v1/user answers 401).
//           When set, the supabase-js session is seeded in localStorage before any page script runs.
// - staff:  the signed-in user's `staff` row (shorthand for tables.staff = [staff]).
// - tables: rows per table or view. GET returns the rows (simple `col=eq.value` filters are applied to
//           top-level columns); `.single()` returns the first row, 406 when there is none.
// - rpc:    handlers per RPC name, called with the parsed JSON body; their return value is the response.
// Every request to the fake project is recorded in `calls` as { path, query, method, body }.

export const SUPABASE_URL = "https://test.supabase.co";
export const ANON_KEY = "test-anon-key";
const STORAGE_KEY = "sb-test-auth-token"; // supabase-js: `sb-${hostname.split(".")[0]}-auth-token`

const b64url = o => Buffer.from(JSON.stringify(o)).toString("base64url");
const fakeJwt = user => `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url({ sub: user.id, email: user.email, role: "authenticated", aud: "authenticated", exp: 4102444800 })}.signature`;

export function sessionFor(user) {
  return { access_token: fakeJwt(user), token_type: "bearer", expires_in: 3600, expires_at: 4102444800, refresh_token: "test-refresh-token", user };
}

const json = (status, body, headers = {}) => ({
  status, headers: { "content-type": "application/json", "access-control-allow-origin": "*", ...headers },
  body: body === undefined ? "" : JSON.stringify(body),
});

function parseBody(req) {
  const raw = req.postData();
  if (raw == null || raw === "") return null;
  try { return JSON.parse(raw); } catch (_) { return raw; }
}

function eqFilter(rows, params) {
  let out = rows;
  for (const [k, v] of params) {
    if (["select", "order", "limit", "offset", "or", "and", "on_conflict", "columns"].includes(k)) continue;
    if (!v.startsWith("eq.")) continue;
    const want = v.slice(3);
    out = out.filter(r => !(k in r) || String(r[k]) === want);
  }
  return out;
}

export async function mockSupabase(page, { user = null, staff = null, tables = {}, rpc = {} } = {}) {
  const calls = [];
  const data = { ...(staff ? { staff: [staff] } : {}), ...tables };

  await page.route(/\/config\.js(\?.*)?$/, route => route.fulfill({
    status: 200,
    contentType: "application/javascript",
    body: `window.HARANGSZO_CONFIG = { googleMapsKey: "__GOOGLE_MAPS_KEY__", supabaseUrl: "${SUPABASE_URL}", supabaseAnonKey: "${ANON_KEY}", repo: "szbaliint/harangszo" };`,
  }));

  if (user) {
    await page.addInitScript(([key, value]) => {
      try { localStorage.setItem(key, value); } catch (_) { }
    }, [STORAGE_KEY, JSON.stringify(sessionFor(user))]);
  }

  await page.route(`${SUPABASE_URL}/**`, async route => {
    const req = route.request();
    const url = new URL(req.url());
    const method = req.method();
    if (method === "OPTIONS") return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" } });
    const body = parseBody(req);
    calls.push({ path: url.pathname, query: url.search, method, body });
    const p = url.pathname;

    if (p.startsWith("/auth/v1/")) {
      const what = p.slice("/auth/v1/".length);
      if (what === "user") return route.fulfill(user ? json(200, user) : json(401, { code: 401, error_code: "no_authorization", msg: "This endpoint requires a valid Bearer token" }));
      if (what === "token") return route.fulfill(user ? json(200, sessionFor(user)) : json(400, { code: 400, error_code: "invalid_credentials", msg: "Invalid login credentials" }));
      if (what === "logout") return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*" } });
      return route.fulfill(json(200, {}));
    }

    if (p.startsWith("/rest/v1/rpc/")) {
      const name = p.slice("/rest/v1/rpc/".length);
      const fn = rpc[name];
      if (!fn) return route.fulfill(json(404, { code: "PGRST202", message: `Could not find the function public.${name} in the schema cache`, details: null, hint: null }));
      try { const out = await fn(body ?? Object.fromEntries(url.searchParams)); return route.fulfill(json(200, out ?? null)); }
      catch (e) { return route.fulfill(json(400, { code: "P0001", message: String(e?.message || e), details: null, hint: null })); }
    }

    if (p.startsWith("/rest/v1/")) {
      const table = p.slice("/rest/v1/".length);
      const headers = req.headers();
      const prefer = headers["prefer"] || "";
      const single = /vnd\.pgrst\.object/.test(headers["accept"] || "");
      if (method === "GET" || method === "HEAD") {
        const rows = eqFilter(data[table] || [], url.searchParams);
        const range = { "content-range": rows.length ? `0-${rows.length - 1}/${rows.length}` : `*/0` };
        if (method === "HEAD") return route.fulfill({ status: 200, headers: { "access-control-allow-origin": "*", ...range } });
        if (single) return route.fulfill(rows.length ? json(200, rows[0], range) : json(406, { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned", details: "The result contains 0 rows", hint: null }));
        return route.fulfill(json(200, rows, range));
      }
      // POST / PATCH / DELETE: accepted; echo the body only when the caller asked for it back.
      const echo = /return=representation/.test(prefer) ? (Array.isArray(body) ? body : body ? [body] : []) : undefined;
      if (echo && single) return route.fulfill(json(200, echo[0] ?? null));
      return route.fulfill(echo ? json(method === "POST" ? 201 : 200, echo) : { status: method === "POST" ? 201 : 204, headers: { "access-control-allow-origin": "*" } });
    }

    return route.fulfill(json(404, { message: "not mocked: " + p }));
  });

  return { calls };
}
