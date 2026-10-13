// One-time Google Drive setup. Run on your own computer (it opens a browser login):
//
//   GOOGLE_CLIENT_ID=xxx GOOGLE_CLIENT_SECRET=yyy npm run google-auth
//   (optional) DRIVE_ROOT_NAME="Samansamnuek Proposals"
//
// Needs an OAuth client of type "Desktop app" from Google Cloud Console with the Drive API enabled.
// Prints four lines to paste into the server's .env.
const http = require("http");
const crypto = require("crypto");

const id = process.env.GOOGLE_CLIENT_ID;
const secret = process.env.GOOGLE_CLIENT_SECRET;
const rootName = process.env.DRIVE_ROOT_NAME || "Samansamnuek Proposals";
if (!id || !secret) {
  console.error("Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET first (OAuth client type: Desktop app).");
  process.exit(1);
}
const PORT = 53682;
const redirect = `http://127.0.0.1:${PORT}/`;
const state = crypto.randomBytes(12).toString("hex");
const url =
  "https://accounts.google.com/o/oauth2/v2/auth?" +
  new URLSearchParams({
    client_id: id,
    redirect_uri: redirect,
    response_type: "code",
    scope: "https://www.googleapis.com/auth/drive.file",
    access_type: "offline",
    prompt: "consent",
    state,
  });

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, redirect);
  if (!u.searchParams.get("code")) return res.end("Waiting for Google…");
  if (u.searchParams.get("state") !== state) return res.end("State mismatch, try again.");
  try {
    const tok = await (
      await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ code: u.searchParams.get("code"), client_id: id, client_secret: secret, redirect_uri: redirect, grant_type: "authorization_code" }),
      })
    ).json();
    if (!tok.refresh_token) throw new Error("No refresh token returned: " + JSON.stringify(tok));
    const folder = await (
      await fetch("https://www.googleapis.com/drive/v3/files?fields=id,webViewLink", {
        method: "POST",
        headers: { Authorization: "Bearer " + tok.access_token, "Content-Type": "application/json" },
        body: JSON.stringify({ name: rootName, mimeType: "application/vnd.google-apps.folder" }),
      })
    ).json();
    res.end("Done. You can close this tab and go back to the terminal.");
    console.log("\nCreated Drive folder:", folder.webViewLink || folder.id);
    console.log("\nAdd these lines to the server .env, then restart the app (pm2 reload samansamnuek-proposals --update-env):\n");
    console.log(`GOOGLE_CLIENT_ID=${id}`);
    console.log(`GOOGLE_CLIENT_SECRET=${secret}`);
    console.log(`GOOGLE_REFRESH_TOKEN=${tok.refresh_token}`);
    console.log(`DRIVE_FOLDER_ID=${folder.id}\n`);
  } catch (e) {
    res.end("Failed: " + e.message);
    console.error(e);
  }
  server.close();
});
server.listen(PORT, "127.0.0.1", () => {
  console.log("Open this link in your browser and allow access:\n\n" + url + "\n");
});
