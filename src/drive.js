// Google Drive uploads using an OAuth refresh token (scope: drive.file).
// The app can only see files and folders it created itself, so DRIVE_FOLDER_ID
// is created by `npm run google-auth`. Each proposal gets a sub-folder named after its title.
// No external dependencies: plain fetch (Node 18+).
const crypto = require("crypto");

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://www.googleapis.com/drive/v3/files";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const FOLDER = "application/vnd.google-apps.folder";
const SHEET = "application/vnd.google-apps.spreadsheet";
const ALLOWED = new Set(["application/pdf", "application/json", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"]);

const env = () => ({
  id: process.env.GOOGLE_CLIENT_ID,
  secret: process.env.GOOGLE_CLIENT_SECRET,
  refresh: process.env.GOOGLE_REFRESH_TOKEN,
  root: process.env.DRIVE_FOLDER_ID,
});
const configured = () => {
  const e = env();
  return !!(e.id && e.secret && e.refresh && e.root);
};

let cache = { token: null, exp: 0 };
async function accessToken() {
  if (cache.token && cache.exp > Date.now() + 60e3) return cache.token;
  const e = env();
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: e.id, client_secret: e.secret, refresh_token: e.refresh, grant_type: "refresh_token" }),
  });
  if (!r.ok) throw httpErr(502, "เชื่อม Google Drive ไม่ได้ (token หมดอายุหรือถูกยกเลิก ให้รัน npm run google-auth ใหม่)");
  const j = await r.json();
  cache = { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return cache.token;
}

function httpErr(status, message) {
  return Object.assign(new Error(message), { status, expose: true });
}

async function gfetch(url, opts = {}) {
  const r = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: "Bearer " + (await accessToken()) } });
  if (!r.ok) {
    const txt = await r.text();
    console.error("[drive]", r.status, txt.slice(0, 500));
    throw httpErr(502, r.status === 404 ? "ไม่พบโฟลเดอร์ใน Drive (DRIVE_FOLDER_ID ไม่ถูกต้อง)" : "Google Drive ตอบกลับผิดพลาด ลองใหม่อีกครั้ง");
  }
  return r.json();
}

const q = (s) => String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
const cleanName = (s) => String(s || "ไม่มีชื่อ").replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) || "ไม่มีชื่อ";

async function findOne(query) {
  const u = API + "?" + new URLSearchParams({ q: query, fields: "files(id,name,mimeType,webViewLink)", pageSize: "1", supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
  return (await gfetch(u)).files[0] || null;
}

async function ensureFolder(name, parent) {
  const f = await findOne(`name='${q(name)}' and '${q(parent)}' in parents and mimeType='${FOLDER}' and trashed=false`);
  if (f) return f.id;
  const j = await gfetch(API + "?supportsAllDrives=true&fields=id", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, mimeType: FOLDER, parents: [parent] }),
  });
  return j.id;
}

function multipart(meta, mimeType, data) {
  const boundary = "ssn" + crypto.randomBytes(8).toString("hex");
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`),
    data,
    Buffer.from(`\r\n--${boundary}--`),
  ]);
  return { body, type: `multipart/related; boundary=${boundary}` };
}

// Upload into <root>/<folderName>/. Same file name → the existing file is updated (same link).
// convert=true turns an .xlsx into a new Google Sheet (a dated copy each time).
async function upload({ folderName, filename, mimeType, data, convert }) {
  if (!configured()) throw httpErr(503, "ยังไม่ได้ตั้งค่า Google Drive บนเซิร์ฟเวอร์");
  if (!ALLOWED.has(mimeType)) throw httpErr(400, "ประเภทไฟล์นี้บันทึกลง Drive ไม่ได้");
  const folder = await ensureFolder(cleanName(folderName), env().root);
  let name = cleanName(filename);
  let meta;
  let existing = null;
  if (convert) {
    const stamp = new Date().toLocaleString("sv-SE", { timeZone: process.env.TZ || "Asia/Bangkok" }).slice(0, 16);
    name = name.replace(/\.xlsx$/i, "") + " " + stamp;
    meta = { name, parents: [folder], mimeType: SHEET };
  } else {
    existing = await findOne(`name='${q(name)}' and '${q(folder)}' in parents and trashed=false`);
    meta = existing ? {} : { name, parents: [folder] };
  }
  const mp = multipart(meta, mimeType, data);
  const fields = "fields=id,name,webViewLink&supportsAllDrives=true&uploadType=multipart";
  const url = existing ? `${UPLOAD}/${existing.id}?${fields}` : `${UPLOAD}?${fields}`;
  return gfetch(url, { method: existing ? "PATCH" : "POST", headers: { "Content-Type": mp.type }, body: mp.body });
}

module.exports = { configured, upload, accessToken, ensureFolder };
