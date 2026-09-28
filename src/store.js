// File-based storage: one JSON file per proposal in DATA_DIR/proposals.
// Good for a small team; swap for a database later if needed (see CLAUDE.md).
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, "..", "data"));
const PDIR = path.join(DATA_DIR, "proposals");
const TRASH = path.join(DATA_DIR, "trash");
const SEED_FILE = path.join(__dirname, "..", "seed", "rov-10th.json");

const ID_RE = /^[a-f0-9]{12}$/;
const SLUG_RE = /^[A-Za-z0-9_-]{16}$/;

const newId = () => crypto.randomBytes(6).toString("hex");
const newSlug = () => crypto.randomBytes(12).toString("base64url"); // 16 chars, unguessable
const fileOf = (id) => {
  if (!ID_RE.test(id)) throw Object.assign(new Error("bad id"), { status: 404 });
  return path.join(PDIR, id + ".json");
};

async function writeAtomic(file, obj) {
  const tmp = file + "." + process.pid + "." + Date.now() + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(obj));
  await fs.rename(tmp, file);
}

async function readSeed() {
  return JSON.parse(await fs.readFile(SEED_FILE, "utf8"));
}

const metaOf = (rec) => ({
  id: rec.id,
  slug: rec.slug,
  title: rec.title,
  published: !!rec.published,
  client: rec.state?.meta?.client || "",
  createdAt: rec.createdAt,
  updatedAt: rec.updatedAt,
});

async function init() {
  await fs.mkdir(PDIR, { recursive: true });
  await fs.mkdir(TRASH, { recursive: true });
  const files = (await fs.readdir(PDIR)).filter((f) => f.endsWith(".json"));
  if (!files.length) {
    const seed = await readSeed();
    await create({ title: seed.meta?.campaign || "ข้อเสนอแรก", state: seed, published: false });
  }
}

async function list() {
  const files = (await fs.readdir(PDIR)).filter((f) => f.endsWith(".json"));
  const recs = await Promise.all(files.map(async (f) => JSON.parse(await fs.readFile(path.join(PDIR, f), "utf8"))));
  return recs.map(metaOf).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

async function get(id) {
  try {
    return JSON.parse(await fs.readFile(fileOf(id), "utf8"));
  } catch (e) {
    if (e.code === "ENOENT" || e.status === 404) return null;
    throw e;
  }
}

async function getBySlug(slug) {
  if (!SLUG_RE.test(slug)) return null;
  const files = (await fs.readdir(PDIR)).filter((f) => f.endsWith(".json"));
  for (const f of files) {
    const rec = JSON.parse(await fs.readFile(path.join(PDIR, f), "utf8"));
    if (rec.slug === slug) return rec;
  }
  return null;
}

async function create({ title, state, published = false }) {
  const now = new Date().toISOString();
  const rec = { id: newId(), slug: newSlug(), title: String(title || "ข้อเสนอใหม่").slice(0, 200), published, createdAt: now, updatedAt: now, state };
  rec.state.updatedAt = now;
  await writeAtomic(fileOf(rec.id), rec);
  return rec;
}

// Optimistic concurrency: if baseUpdatedAt is given and differs from the stored
// updatedAt, someone else saved first -> 409.
async function update(id, { title, published, state, baseUpdatedAt }) {
  const rec = await get(id);
  if (!rec) return { status: 404 };
  if (baseUpdatedAt && baseUpdatedAt !== rec.updatedAt) return { status: 409, rec };
  const now = new Date().toISOString();
  if (title !== undefined) rec.title = String(title).slice(0, 200);
  if (published !== undefined) rec.published = !!published;
  if (state !== undefined) rec.state = state;
  rec.updatedAt = now;
  rec.state.updatedAt = now;
  await writeAtomic(fileOf(id), rec);
  return { status: 200, rec };
}

async function newLink(id) {
  const rec = await get(id);
  if (!rec) return null;
  rec.slug = newSlug();
  rec.updatedAt = new Date().toISOString();
  await writeAtomic(fileOf(id), rec);
  return rec;
}

// Deleted proposals are moved to DATA_DIR/trash, not destroyed.
async function remove(id) {
  const file = fileOf(id);
  try {
    await fs.rename(file, path.join(TRASH, id + "-" + Date.now() + ".json"));
    return true;
  } catch (e) {
    if (e.code === "ENOENT") return false;
    throw e;
  }
}

module.exports = { init, list, get, getBySlug, create, update, newLink, remove, readSeed, metaOf, DATA_DIR };
