# Samansamnuek Creator Proposals

A proposal site with two parts:

| URL | Who | What |
|---|---|---|
| `/admin` | Team only (password) | List of proposals, full backend: rates, formulas, discounts, channels, CI, quotation settings |
| `/p/<link>` | Client | Read-only proposal. Client can pick channels/phases and see totals, copy text, download .xlsx/.csv and the PDF quotation |

The client link never receives pricing formulas (phase components, ratios, floors), manual overrides, hidden channels or internal notes. The server turns every price into a final number before sending it (`src/publicView.js`).

## Run it locally

```bash
npm install
cp .env.example .env
npm run hash-password -- "a long passphrase"   # paste the output line into .env
node -e "console.log('SESSION_SECRET='+require('crypto').randomBytes(32).toString('hex'))" >> .env
npm start
# open http://localhost:3000/admin
```

The first start creates one proposal from `seed/rov-10th.json` (the RoV 10th campaign). It starts with the client link **closed**; tick "เปิดลิงก์ให้ลูกค้า" and save to open it.

## Deploy on the samansamnuek server

### One command (from your computer or Claude Code)
Needs SSH key access to the server (`ssh ubuntu@103.234.238.50` works without a password prompt), `rsync`, and Node on your machine.
```bash
chmod +x deploy/deploy.sh
./deploy/deploy.sh ubuntu@103.234.238.50 --domain proposals.samansamnuek.com --email you@samansamnuek.com
```
- Point a DNS A record for the domain to `103.234.238.50` first; the script sets up nginx + a Let's Encrypt certificate.
- Without `--domain` it serves on `http://103.234.238.50:3000/admin` (plain HTTP — fine for a test, not for sending client links).
- First run installs Node 20 + pm2, asks for the admin password and writes the server's `.env` (never overwritten later).
- Code goes to `~/samansamnuek-proposals`, proposals to `~/samansamnuek-proposals-data` (kept across deploys — back this folder up).
- Run the same command again to deploy an update. On the server run `pm2 startup` once so it restarts after a reboot.

### Automatic on every push (GitHub Actions)
`.github/workflows/deploy.yml` runs the tests and deploys when you push to `main`. Do the first deploy with the script above, then add repo secrets `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`.

### Docker (alternative)
```bash
cp .env.example .env    # fill it in
docker compose up -d --build
```
nginx examples for a subdomain or a sub-path (`BASE_PATH=/proposals`) are in `deploy/nginx.conf.example`.

## Everyday use

1. Go to `/admin`, log in.
2. **ทำสำเนา** an existing proposal (keeps the roster and rates) or **+ ข้อเสนอใหม่จากเทมเพลต**.
3. Edit in the Backend drawer, tick **เปิดลิงก์ให้ลูกค้า**, press **บันทึก**.
4. **คัดลอกลิงก์** and send it to the client. **สร้างลิงก์ใหม่** revokes the old link immediately.

## Data and backups

Each proposal is one JSON file in `DATA_DIR/proposals/`. Deleting moves the file to `DATA_DIR/trash/`. Back up the `data/` folder (for example with a daily cron `tar`/rsync).

## Security notes

- One shared admin password (scrypt hash in `.env`), 12-hour HttpOnly + SameSite=Strict session cookie, 10 failed logins per IP per 15 minutes.
- Client links are 16-character random tokens and pages send `noindex`.
- Strict Content-Security-Policy; the PDF/XLSX libraries are served from this server, not a CDN.
- Change the password by generating a new hash and restarting. Changing `SESSION_SECRET` logs everyone out.

## Tests

```bash
npm test
```
Covers login, the 401 wall, publish/unpublish, the client payload not leaking formulas, save conflicts, duplicate/delete.
