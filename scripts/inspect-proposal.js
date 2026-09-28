// Read-only: prints the pricing structure of a saved proposal and what its client link receives.
// Run on the server from the app folder:  node scripts/inspect-proposal.js <client-link-slug>
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { toPublic } = require("../src/publicView");

const slug = process.argv[2];
const dir = path.join(path.resolve(process.env.DATA_DIR || "./data"), "proposals");
const recs = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
const rec = recs.find((r) => r.slug === slug);
if (!rec) {
  console.log("No proposal with that link. Links on this server:", recs.map((r) => `${r.slug} (${r.title}, published=${r.published})`));
  process.exit(1);
}
const s = rec.state;
const pub = toPublic(s);
const short = (v) => JSON.stringify(v);
console.log("title:", rec.title, "| published:", rec.published, "| updatedAt:", rec.updatedAt);
console.log("state keys:", Object.keys(s).join(","));
console.log("settings:", short({ roundTo: s.settings?.roundTo, showClipPrice: s.settings?.showClipPrice, bundleOn: s.settings?.bundleOn, tierOn: s.settings?.tierOn, vatMode: s.settings?.vatMode }));
console.log("itemTypes:", short((s.itemTypes || []).map((t) => [t.id, t.ratio, t.floor, t.included])));
console.log("phases:", short((s.phases || []).map((p) => ({ id: p.id, keys: Object.keys(p), items: (p.items || []).map((it) => [it.type, it.qty]), comps: p.comps ? p.comps.length : undefined }))));
console.log("extras:", short((s.extras || []).map((x) => [x.type, x.value, x.on])));
for (const c of s.channels || []) {
  console.log("channel:", short({ name: c.name, on: c.on, price: c.price, priceType: typeof c.price, keys: Object.keys(c).filter((k) => !["avatar", "note", "platforms"].includes(k)), ph: c.ph, rates: c.rates, override: c.override }));
}
console.log("--- client receives ---");
console.log("channels:", pub.channels.length, "| phases:", short(pub.phases.map((p) => [p.id, p.items.length])));
for (const c of pub.channels) console.log("client channel:", short({ name: c.name, price: c.price, itemRate: c.itemRate, phaseTotal: c.phaseTotal, ph: c.ph }));

// Run the client page's own pricing code (public/assets/app.js) on the client payload.
const vm = require("vm");
const noop = () => {};
const el = { dataset: { mode: "none", base: "" }, addEventListener: noop };
const ctx = vm.createContext({
  document: { body: el, querySelector: () => null, querySelectorAll: () => [], addEventListener: noop, createElement: () => el },
  addEventListener: noop, location: { pathname: "/", origin: "" }, localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
  fetch: () => new Promise(noop), setTimeout, clearTimeout, console,
});
vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "public", "assets", "app.js"), "utf8"), ctx);
ctx.__pub = JSON.parse(JSON.stringify(pub));
const out = vm.runInContext(`(() => {
  S = __pub; DEFAULT = clone(S); normalize();
  const q = quote();
  return {
    grand: q.grand, pre: q.pre, net: q.net, selected: q.sel.length,
    channels: q.list.map(({ c, k }) => ({ name: c.name, total: k.total, phases: k.rows.map(r => [r.ph.id, r.on, r.price, r.lines.map(l => [l.t.id, l.qty, l.unit])]) })),
    byPhase: S.phases.map(ph => { const s = phaseSummary(ph); return [ph.id, s.rows.length, s.grand]; }),
  };
})()`, ctx);
console.log("--- client page calculation ---");
console.log("grand total:", out.grand, "| before VAT:", out.pre, "| content:", out.net, "| channels selected:", out.selected);
console.log("by phase [id, channels, total]:", short(out.byPhase));
for (const c of out.channels) console.log("calc:", short(c));
