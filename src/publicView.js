// Builds the client-safe version of a proposal.
// The client page only ever receives final prices. The rate card formulas
// (itemTypes ratio/floor), per-channel rate and phase overrides, opportunity-cost
// inputs, hidden channels and internal notes are removed here.
//
// Pricing maths must match public/assets/app.js (autoRate / phaseCalc / chExtraAmt).

const rnd = (n, roundTo) => {
  const r = +roundTo || 1;
  return Math.round(n / r) * r;
};
const isSet = (v) => v !== undefined && v !== "" && v !== null;
const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj?.[k] !== undefined).map((k) => [k, obj[k]]));

function rateFor(channel, type, settings) {
  const ov = channel.rates?.[type.id];
  if (isSet(ov)) return +ov;
  if (type.included) return 0;
  return rnd(Math.max((+type.ratio || 0) * (+channel.price || 0), +type.floor || 0), settings.roundTo);
}

function extraAmtFor(channel, extra, settings) {
  if (extra.type === "opportunity") {
    return rnd((+channel.price || 0) * (+extra.jobs || 0) * (+extra.months || 0) * ((+extra.likelihood || 0) / 100), settings.roundTo);
  }
  return undefined; // other types are computed on the page from public values
}

function toPublic(state) {
  const settings = state.settings || {};
  const showClip = settings.showClipPrice !== false;
  const types = state.itemTypes || [];
  const extrasOn = (state.extras || []).filter((x) => x.on);
  return {
    updatedAt: state.updatedAt,
    brand: pick(state.brand, ["name", "tagline", "logo", "logo2", "primary", "accent", "ink", "paper", "soft", "gray1", "gray2", "displayFont", "latinFont", "contactEmail", "contactPhone", "website"]),
    company: pick(state.company, ["nameTh", "nameEn", "address", "taxId", "email", "phone"]),
    meta: pick(state.meta, ["campaign", "client", "brand", "date", "valid", "intro"]),
    quote: pick(state.quote, ["number", "date", "project", "sectionTitle", "clientBlock", "mode", "useCustom", "customItems", "includePh", "notes", "signName", "showSign"]),
    settings: pick(settings, ["roundTo", "bundlePct", "bundleOn", "tierOn", "vatMode", "vatPct", "manualDiscount", "manualDiscountLabel", "tiers", "focusPhase", "showClipPrice"]),
    itemTypes: types.map((t) => pick(t, ["id", "label", "unit", "included"])),
    extras: extrasOn.map((x) => pick(x, ["id", "label", "type", "value", "on"])),
    phases: (state.phases || []).map((p) => ({
      ...pick(p, ["id", "name", "dates", "deliverables"]),
      items: (p.items || []).map((it) => pick(it, ["id", "type", "label", "qty", "rush"])),
    })),
    channels: (state.channels || [])
      .filter((c) => c.on)
      .map((c) => {
        const out = {
          ...pick(c, ["id", "name", "niche", "avatar", "note", "platforms", "rush", "vat", "ph"]),
          on: true,
          price: showClip ? +c.price || 0 : 0,
          itemRate: Object.fromEntries(types.map((t) => [t.id, rateFor(c, t, settings)])),
          phaseTotal: {},
          extraAmt: {},
        };
        for (const p of state.phases || []) if (isSet(c.override?.[p.id])) out.phaseTotal[p.id] = +c.override[p.id];
        for (const x of extrasOn) {
          const a = extraAmtFor(c, x, settings);
          if (a !== undefined) out.extraAmt[x.id] = a;
        }
        return out;
      }),
    terms: state.terms || "",
  };
}

module.exports = { toPublic, rateFor };
