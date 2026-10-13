// Drive upload logic against a fake Google API (no network).
const { test } = require("node:test");
const assert = require("node:assert");

process.env.GOOGLE_CLIENT_ID = "cid";
process.env.GOOGLE_CLIENT_SECRET = "sec";
process.env.GOOGLE_REFRESH_TOKEN = "ref";
process.env.DRIVE_FOLDER_ID = "ROOT";
const drive = require("../src/drive");

function fakeGoogle(files) {
  const calls = [];
  global.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || "GET", headers: opts.headers || {}, body: opts.body });
    const ok = (j) => ({ ok: true, status: 200, json: async () => j, text: async () => JSON.stringify(j) });
    if (String(url).startsWith("https://oauth2.googleapis.com/token")) return ok({ access_token: "AT", expires_in: 3600 });
    const u = new URL(url);
    if (u.pathname === "/drive/v3/files" && (opts.method || "GET") === "GET") {
      const qq = u.searchParams.get("q");
      const hit = files.find((f) => qq.includes(`name='${f.name}'`) && qq.includes(`'${f.parent}' in parents`));
      return ok({ files: hit ? [hit] : [] });
    }
    if (u.pathname === "/drive/v3/files" && opts.method === "POST") {
      const meta = JSON.parse(opts.body);
      const f = { id: "F" + (files.length + 1), name: meta.name, parent: meta.parents[0], mimeType: meta.mimeType };
      files.push(f);
      return ok({ id: f.id });
    }
    if (u.pathname.startsWith("/upload/drive/v3/files")) return ok({ id: "UP", name: "x", webViewLink: "https://drive.google.com/file/d/UP/view" });
    return { ok: false, status: 500, json: async () => ({}), text: async () => "unexpected " + url };
  };
  return calls;
}

test("creates the proposal folder once, then uploads a new file", async () => {
  const files = [];
  const calls = fakeGoogle(files);
  const r = await drive.upload({ folderName: "10 ปี RoV", filename: "Quotation-1.pdf", mimeType: "application/pdf", data: Buffer.from("%PDF-1.4") });
  assert.equal(r.webViewLink, "https://drive.google.com/file/d/UP/view");
  assert.equal(files.filter((f) => f.mimeType === "application/vnd.google-apps.folder").length, 1);
  const up = calls.find((c) => c.url.includes("/upload/"));
  assert.equal(up.method, "POST");
  assert.match(up.headers["Content-Type"], /multipart\/related/);
  assert.ok(up.body.includes(Buffer.from('"parents":["F1"]')), "uploaded into the proposal folder");
  assert.equal(up.headers.Authorization, "Bearer AT");
});

test("same file name updates the existing file instead of duplicating", async () => {
  const files = [{ id: "FOLD", name: "Job", parent: "ROOT", mimeType: "application/vnd.google-apps.folder" }, { id: "OLD", name: "Invoice-7.pdf", parent: "FOLD" }];
  const calls = fakeGoogle(files);
  await drive.upload({ folderName: "Job", filename: "Invoice-7.pdf", mimeType: "application/pdf", data: Buffer.from("x") });
  const up = calls.find((c) => c.url.includes("/upload/"));
  assert.equal(up.method, "PATCH");
  assert.ok(up.url.includes("/files/OLD?"));
});

test("xlsx can be converted to a Google Sheet; other types are refused", async () => {
  const calls = fakeGoogle([]);
  await drive.upload({ folderName: "Job", filename: "rates.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", data: Buffer.from("PK"), convert: true });
  const up = calls.find((c) => c.url.includes("/upload/"));
  assert.ok(up.body.includes(Buffer.from("application/vnd.google-apps.spreadsheet")));
  await assert.rejects(drive.upload({ folderName: "Job", filename: "x.exe", mimeType: "application/x-msdownload", data: Buffer.from("MZ") }), /บันทึกลง Drive ไม่ได้/);
});
