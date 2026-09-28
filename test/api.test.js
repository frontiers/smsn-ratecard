// Run: npm test
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const os = require("os");
const fs = require("fs");
const path = require("path");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ssn-"));
process.env.DATA_DIR = tmp;
process.env.ADMIN_PASSWORD = "test-password-123";
process.env.SESSION_SECRET = "x".repeat(64);
const { app, store } = require("../server");

let server, base, cookie;
const req = async (p, opts = {}) => {
  const r = await fetch(base + p, {
    ...opts,
    headers: { ...(opts.body ? { "Content-Type": "application/json" } : {}), ...(cookie ? { cookie } : {}), ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    redirect: "manual",
  });
  let data = null;
  try { data = await r.clone().json(); } catch {}
  return { r, data, text: data ? null : await r.text() };
};

before(async () => {
  await store.init();
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test("admin API needs login", async () => {
  assert.equal((await req("/api/proposals")).r.status, 401);
  assert.equal((await req("/api/seed")).r.status, 401);
});

test("wrong password is rejected, right one sets an HttpOnly cookie", async () => {
  assert.equal((await req("/api/login", { method: "POST", body: { password: "nope" } })).r.status, 401);
  const ok = await req("/api/login", { method: "POST", body: { password: "test-password-123" } });
  assert.equal(ok.r.status, 200);
  const sc = ok.r.headers.get("set-cookie");
  assert.match(sc, /HttpOnly/);
  assert.match(sc, /SameSite=Strict/);
  cookie = sc.split(";")[0];
  assert.equal((await req("/api/me")).data.authenticated, true);
});

test("client link is hidden until published, then serves only final prices", async () => {
  const { data } = await req("/api/proposals");
  const meta = data.items[0];
  const saveCookie = cookie;
  cookie = null;
  assert.equal((await req(`/api/public/${meta.slug}`)).r.status, 404);
  cookie = saveCookie;

  const full = await req(`/api/proposals/${meta.id}`);
  const st = full.data.state;
  st.channels[0].override = { p4: 99999 };
  st.channels[0].rates = { live: 7777 };
  st.extras.push({ id: "opp", label: "กันแบรนด์ประเมิน", type: "opportunity", on: true, jobs: 2, months: 1, likelihood: 10, note: "ภายในเท่านั้น" });
  const put = await req(`/api/proposals/${meta.id}`, { method: "PUT", body: { published: true, state: st, baseUpdatedAt: meta.updatedAt } });
  assert.equal(put.r.status, 200);

  cookie = null;
  const pub = await req(`/api/public/${meta.slug}`);
  assert.equal(pub.r.status, 200);
  const body = JSON.stringify(pub.data);
  for (const secret of ['"comps"', '"ratio"', '"floor"', '"override"', '"rates"', '"jobs"', '"likelihood"', "ภายในเท่านั้น", "อ้างอิงเรท"]) assert.ok(!body.includes(secret), "leaked " + secret);
  assert.equal(pub.data.channels[0].phaseTotal.p4, 99999);
  assert.equal(pub.data.channels[0].itemRate.live, 7777);
  assert.equal(pub.data.channels[0].itemRate.event, 0, "included items cost 0");
  assert.equal(pub.data.channels[0].extraAmt.opp, 6000, "30,000 x 2 jobs x 1 month x 10%");
  assert.ok(!pub.data.channels.some((c) => "notes" in c));
  assert.ok(pub.data.channels.every((c) => c.on), "hidden channels must not be sent");
  assert.equal((await req(`/p/${meta.slug}`)).r.status, 200);
  cookie = saveCookie;
});

test("stale save returns 409", async () => {
  const { data } = await req("/api/proposals");
  const meta = data.items[0];
  const full = await req(`/api/proposals/${meta.id}`);
  const r = await req(`/api/proposals/${meta.id}`, { method: "PUT", body: { title: "x", state: full.data.state, baseUpdatedAt: "2000-01-01T00:00:00.000Z" } });
  assert.equal(r.r.status, 409);
});

test("duplicate gets a new private link; delete moves to trash", async () => {
  const { data } = await req("/api/proposals");
  const src = data.items[0];
  const dup = await req("/api/proposals", { method: "POST", body: { fromId: src.id } });
  assert.equal(dup.r.status, 201);
  assert.notEqual(dup.data.meta.slug, src.slug);
  assert.equal(dup.data.meta.published, false);
  const del = await req(`/api/proposals/${dup.data.meta.id}`, { method: "DELETE" });
  assert.equal(del.r.status, 200);
  assert.ok(fs.readdirSync(path.join(tmp, "trash")).length >= 1);
});

test("bad ids and slugs are 404, not errors", async () => {
  assert.equal((await req("/api/proposals/../../etc")).r.status, 404);
  assert.equal((await req("/api/public/nope")).r.status, 404);
});
