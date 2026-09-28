// Single shared admin password + signed, HttpOnly session cookie.
// No external auth dependencies: scrypt for password hashes, HMAC-SHA256 for cookies.
const crypto = require("crypto");

const COOKIE = "ssn_admin";
const HOURS = +process.env.SESSION_HOURS || 12;

let SECRET = process.env.SESSION_SECRET;
if (!SECRET) {
  SECRET = crypto.randomBytes(32).toString("hex");
  console.warn("[auth] SESSION_SECRET is not set: using a random one. Everyone is logged out when the server restarts.");
}

// ADMIN_PASSWORD_HASH (from `npm run hash-password`) is preferred; ADMIN_PASSWORD is accepted for quick setups.
function hashPassword(pw, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(pw, salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

function checkPassword(pw) {
  if (typeof pw !== "string" || !pw) return false;
  const stored = process.env.ADMIN_PASSWORD_HASH;
  if (stored) {
    const [algo, salt, hash] = stored.split("$");
    if (algo !== "scrypt" || !salt || !hash) return false;
    const got = crypto.scryptSync(pw, salt, 64);
    const want = Buffer.from(hash, "hex");
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  }
  const plain = process.env.ADMIN_PASSWORD;
  if (!plain) return false;
  const a = crypto.createHash("sha256").update(pw).digest();
  const b = crypto.createHash("sha256").update(plain).digest();
  return crypto.timingSafeEqual(a, b);
}

const sign = (v) => crypto.createHmac("sha256", SECRET).update(v).digest("base64url");

function makeToken() {
  const payload = `${Date.now() + HOURS * 3600e3}.${crypto.randomBytes(8).toString("hex")}`;
  return `${payload}.${sign(payload)}`;
}

function verifyToken(tok) {
  if (!tok) return false;
  const i = tok.lastIndexOf(".");
  if (i < 0) return false;
  const payload = tok.slice(0, i);
  const sig = Buffer.from(tok.slice(i + 1));
  const want = Buffer.from(sign(payload));
  if (sig.length !== want.length || !crypto.timingSafeEqual(sig, want)) return false;
  return +payload.split(".")[0] > Date.now();
}

function readCookie(req, name) {
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

function cookieFlags(req) {
  const secure = process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === "1" : req.secure;
  const base = process.env.BASE_PATH || "/";
  return `Path=${base}; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
}

function setSession(req, res) {
  res.setHeader("Set-Cookie", `${COOKIE}=${encodeURIComponent(makeToken())}; Max-Age=${HOURS * 3600}; ${cookieFlags(req)}`);
}

function clearSession(req, res) {
  res.setHeader("Set-Cookie", `${COOKIE}=; Max-Age=0; ${cookieFlags(req)}`);
}

const isAuthed = (req) => verifyToken(readCookie(req, COOKIE));

function requireAuth(req, res, next) {
  if (isAuthed(req)) return next();
  res.status(401).json({ error: "กรุณาเข้าสู่ระบบ" });
}

// Simple in-memory login throttle: 10 failed tries per IP per 15 minutes.
const tries = new Map();
function loginAllowed(ip) {
  const t = tries.get(ip);
  if (!t || t.reset < Date.now()) return true;
  return t.count < 10;
}
function loginFailed(ip) {
  const t = tries.get(ip);
  if (!t || t.reset < Date.now()) tries.set(ip, { count: 1, reset: Date.now() + 15 * 60e3 });
  else t.count++;
}
const loginOk = (ip) => tries.delete(ip);

module.exports = { hashPassword, checkPassword, setSession, clearSession, isAuthed, requireAuth, loginAllowed, loginFailed, loginOk };
