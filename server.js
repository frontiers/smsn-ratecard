// Samansamnuek creator proposals
//   /admin            password-protected backend (list + editor)
//   /p/<slug>         client link: read-only, final prices only
require("dotenv").config();
const path = require("path");
const fs = require("fs");
const express = require("express");
const store = require("./src/store");
const auth = require("./src/auth");
const { toPublic } = require("./src/publicView");

const PORT = +process.env.PORT || 3000;
const BASE = (process.env.BASE_PATH || "").replace(/\/$/, ""); // e.g. "/proposals" when served under a sub-path

const app = express();
app.disable("x-powered-by");
if (process.env.TRUST_PROXY) app.set("trust proxy", process.env.TRUST_PROXY === "1" ? 1 : process.env.TRUST_PROXY);

// ---------- security headers ----------
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join("; ");
app.use((req, res, next) => {
  res.setHeader("Content-Security-Policy", CSP);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  next();
});

const router = express.Router();
router.use(express.json({ limit: process.env.MAX_BODY || "12mb" }));

// ---------- static ----------
const html = (name) => fs.readFileSync(path.join(__dirname, "public", name), "utf8").replaceAll("%%BASE%%", BASE);
const PAGES = { admin: html("admin.html"), proposal: html("proposal.html") };
const sendPage = (res, name, status = 200) => res.status(status).set("Cache-Control", "no-store").type("html").send(PAGES[name]);

router.use("/assets", express.static(path.join(__dirname, "public", "assets"), { maxAge: "1h" }));
const VENDOR = {
  "html2canvas.min.js": require.resolve("html2canvas/dist/html2canvas.min.js"),
  "jspdf.umd.min.js": require.resolve("jspdf/dist/jspdf.umd.min.js"),
  "xlsx.full.min.js": require.resolve("xlsx/dist/xlsx.full.min.js"),
};
router.get("/vendor/:file", (req, res) => {
  const f = VENDOR[req.params.file];
  if (!f) return res.sendStatus(404);
  res.set("Cache-Control", "public, max-age=604800").sendFile(f);
});

router.get("/healthz", (req, res) => res.json({ ok: true }));

// ---------- client ----------
router.get("/p/:slug", async (req, res) => {
  const rec = await store.getBySlug(req.params.slug);
  sendPage(res, "proposal", rec && rec.published ? 200 : 404); // page itself shows "not found" when the API 404s
});
router.get("/api/public/:slug", async (req, res) => {
  const rec = await store.getBySlug(req.params.slug);
  if (!rec || !rec.published) return res.status(404).json({ error: "not found" });
  res.set("Cache-Control", "no-store").json(toPublic(rec.state));
});

// ---------- auth ----------
const ipOf = (req) => req.ip || req.socket.remoteAddress || "?";
router.post("/api/login", (req, res) => {
  const ip = ipOf(req);
  if (!auth.loginAllowed(ip)) return res.status(429).json({ error: "too many attempts" });
  if (!auth.checkPassword(req.body?.password)) {
    auth.loginFailed(ip);
    return res.status(401).json({ error: "wrong password" });
  }
  auth.loginOk(ip);
  auth.setSession(req, res);
  res.json({ ok: true });
});
router.post("/api/logout", (req, res) => {
  auth.clearSession(req, res);
  res.json({ ok: true });
});
router.get("/api/me", (req, res) => res.set("Cache-Control", "no-store").json({ authenticated: auth.isAuthed(req) }));

// ---------- admin API ----------
const admin = express.Router();
admin.use(auth.requireAuth, (req, res, next) => {
  res.set("Cache-Control", "no-store");
  // CSRF: the session cookie is SameSite=Strict and every write must be JSON.
  if (!["GET", "HEAD"].includes(req.method) && !req.is("application/json") && req.method !== "DELETE") {
    return res.status(415).json({ error: "JSON only" });
  }
  next();
});
const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);
const validState = (s) => s && typeof s === "object" && Array.isArray(s.channels) && Array.isArray(s.phases) && s.settings && s.meta;

admin.get("/seed", wrap(async (req, res) => res.json(await store.readSeed())));
admin.get("/proposals", wrap(async (req, res) => res.json({ items: await store.list() })));
admin.post("/proposals", wrap(async (req, res) => {
  const fromId = req.body?.fromId;
  let state, title;
  if (fromId) {
    const src = await store.get(fromId);
    if (!src) return res.status(404).json({ error: "not found" });
    state = src.state;
    title = src.title + " (สำเนา)";
  } else {
    state = await store.readSeed();
    title = "ข้อเสนอใหม่";
  }
  const rec = await store.create({ title, state, published: false });
  res.status(201).json({ meta: store.metaOf(rec) });
}));
admin.get("/proposals/:id", wrap(async (req, res) => {
  const rec = await store.get(req.params.id);
  if (!rec) return res.status(404).json({ error: "not found" });
  res.json({ meta: store.metaOf(rec), state: rec.state });
}));
admin.put("/proposals/:id", wrap(async (req, res) => {
  const { title, published, state, baseUpdatedAt } = req.body || {};
  if (state !== undefined && !validState(state)) return res.status(400).json({ error: "ข้อมูลไม่ถูกต้อง" });
  const r = await store.update(req.params.id, { title, published, state, baseUpdatedAt });
  if (r.status === 404) return res.status(404).json({ error: "not found" });
  if (r.status === 409) return res.status(409).json({ error: "conflict", meta: store.metaOf(r.rec) });
  res.json({ meta: store.metaOf(r.rec) });
}));
admin.post("/proposals/:id/new-link", wrap(async (req, res) => {
  const rec = await store.newLink(req.params.id);
  if (!rec) return res.status(404).json({ error: "not found" });
  res.json({ meta: store.metaOf(rec) });
}));
admin.delete("/proposals/:id", wrap(async (req, res) => {
  const ok = await store.remove(req.params.id);
  res.status(ok ? 200 : 404).json({ ok });
}));
router.use("/api", admin);

// ---------- admin pages ----------
router.get(["/admin", "/admin/*"], (req, res) => sendPage(res, "admin"));
router.get("/", (req, res) => res.redirect(BASE + "/admin"));

app.use(BASE || "/", router);
app.use((req, res) => res.status(404).type("text").send("Not found"));
app.use((err, req, res, next) => {
  if (err.status === 404) return res.status(404).json({ error: "not found" });
  if (err.type === "entity.too.large") return res.status(413).json({ error: "ข้อมูลใหญ่เกินไป ลองใช้รูปขนาดเล็กลง" });
  console.error(err);
  res.status(500).json({ error: "server error" });
});

if (require.main === module) {
  if (!process.env.ADMIN_PASSWORD && !process.env.ADMIN_PASSWORD_HASH) {
    console.error("Set ADMIN_PASSWORD_HASH (npm run hash-password) or ADMIN_PASSWORD in .env before starting.");
    process.exit(1);
  }
  const HOST = process.env.HOST || "0.0.0.0"; // 127.0.0.1 when nginx is in front
  store.init().then(() => app.listen(PORT, HOST, () => console.log(`Proposals running on http://${HOST}:${PORT}${BASE}/admin`)));
}

module.exports = { app, store };
