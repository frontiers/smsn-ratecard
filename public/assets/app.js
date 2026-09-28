/* =================== state =================== */
"use strict";
const BASE = (document.body.dataset.base || "").replace(/\/$/,"");
const MODE = document.body.dataset.mode;            // "client" | "admin"
const clone = o => JSON.parse(JSON.stringify(o));
let DEFAULT = null;                                  // shape used to fill missing keys (seed in admin, own data in client)
let S = null;                                        // the proposal state being shown
let REC = null;                                      // admin: {id, slug, title, published, updatedAt}
let DRAFT_KEY = "ssn-draft";
const caps = { canEdit:false };
let adminOpen = false, tab = "channels", dirty = false, menuOpen = false, phaseView = null, conflict = false;

function normalize(){
  if(DEFAULT){
    for(const k of Object.keys(DEFAULT)) if(S[k]===undefined) S[k]=clone(DEFAULT[k]);
    for(const k of ["brand","company","meta","quote","settings"]) if(DEFAULT[k]&&S[k]) for(const kk of Object.keys(DEFAULT[k])) if(S[k][kk]===undefined) S[k][kk]=clone(DEFAULT[k][kk]);
  }
  S.extras=S.extras||[]; S.quote.customItems=S.quote.customItems||[];
  S.channels.forEach(c=>{ c.ph=c.ph||{}; c.override=c.override||{}; c.rates=c.rates||{}; c.platforms=c.platforms||[]; if(!c.id) c.id=uid(); });
  migrate();
}
const uid = () => Math.random().toString(36).slice(2,8);
// Older proposals priced phases with "comps" (ratio/floor per phase) and extras of type rush/pct.
function migrate(){
  if(!S.itemTypes) S.itemTypes = DEFAULT?.itemTypes ? clone(DEFAULT.itemTypes) : [];
  S.phases.forEach(ph=>{
    if(!ph.items){
      ph.items=(ph.comps||[]).map((x,i)=>{ const id="t"+uid(); S.itemTypes.push({id,label:x.label,unit:"",ratio:+x.ratio||0,floor:+x.floor||0,included:false,note:""});
        return {id:"i"+uid(),type:id,label:x.label,qty:+x.qty||1,rush:!!ph.rush&&i===0}; });
    }
    delete ph.comps; delete ph.rush;
  });
  S.extras=(S.extras||[]).filter(x=>x.type!=="rush").map(x=>x.type==="pct"?{...x,type:"dealPct"}:x);
}
const $ = s => document.querySelector(s);
const esc = s => String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const fmt = n => Math.round(+n||0).toLocaleString("en-US");
const fmt2 = n => (+n||0).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2});
const rnd = n => { const r=+S.settings.roundTo||1; return Math.round(n/r)*r; };
function compact(n){ n=+n||0; if(n>=1e6) return (n/1e6).toFixed(n>=1e7?1:2).replace(/\.?0+$/,"")+"M"; if(n>=1e3) return (n/1e3).toFixed(n>=1e5?0:1).replace(/\.0$/,"")+"K"; return String(n); }
function parseCount(v){ if(typeof v==="number") return v; v=String(v).trim().replace(/,/g,""); const m=v.match(/^([\d.]+)\s*([kKmM]?)$/); if(!m) return +v||0; const x=parseFloat(m[1]); return Math.round(m[2].toLowerCase()==="m"?x*1e6:m[2].toLowerCase()==="k"?x*1e3:x); }
const getPath = p => p.split(".").reduce((o,k)=>o?.[k], S);
function setPath(p,v){ const ks=p.split("."); const last=ks.pop(); const o=ks.reduce((o,k)=>o[k],S); o[last]=v; }

/* =================== pricing =================== */
// Model
//   S.itemTypes  rate-card items: {id,label,unit,ratio,floor,included,note}
//                price for a channel = channel.rates[id] if set, else max(ratio × clip price, floor), rounded; included → 0
//   S.phases[].items  {id,type,label,qty,rush}   rush → + channel.rush × qty ("ค่าเร่งงาน")
//   channel.override[phaseId]  replaces the phase price (items become informational)
//   S.extras  {type:"dealPct"|"dealFixed"} charged ONCE per deal after discounts
//             {type:"fixed"|"perPhase"|"opportunity"} charged once per channel
//   Client pages get c.itemRate / c.phaseTotal / c.extraAmt pre-computed by the server (src/publicView.js).
let unpick=new Set(), unpickPh=new Set();
const picked = c => adminOpen || !unpick.has(c.id);
const phOn = (c,ph) => c.ph?.[ph.id]!==false && (adminOpen || !unpickPh.has(ph.id));
const DEAL_TYPES=["dealPct","dealFixed"];
const isDeal = x => DEAL_TYPES.includes(x.type);
function nextTier(n){ const ts=[...S.settings.tiers].sort((a,b)=>a.min-b.min); const cur=tierFor(n); const nx=ts.find(t=>+t.min>n && +t.pct>cur); return nx?{need:nx.min-n,pct:+nx.pct}:null; }
function reach(c){ return c.platforms.reduce((s,p)=>s+(+p.followers||0),0); }
function mainHandle(c){ return c.platforms[0]?.handle||""; }
const typeOf = id => (S.itemTypes||[]).find(t=>t.id===id) || {id, label:id, unit:"", ratio:0, floor:0};
function autoRate(c,t){ return t.included ? 0 : rnd(Math.max((+t.ratio||0)*(+c.price||0), +t.floor||0)); }
function rateOf(c,t){
  const pub=c.itemRate?.[t.id]; if(pub!==undefined) return +pub;
  const ov=c.rates?.[t.id]; if(ov!==undefined && ov!=="" && ov!==null) return +ov;
  return autoRate(c,t);
}
function phaseCalc(c,ph){
  const lines=(ph.items||[]).map(it=>{ const t=typeOf(it.type); const unit=rateOf(c,t); const qty=+it.qty||0;
    return {it,t,label:it.label||t.label,qty,unit,amt:unit*qty,included:!!t.included||unit===0}; });
  const items=lines.reduce((s,l)=>s+l.amt,0);
  const rush=(ph.items||[]).reduce((s,it)=>s+(it.rush?(+it.qty||0)*(+c.rush||0):0),0);
  const pubTot=c.phaseTotal?.[ph.id], ov=c.override?.[ph.id];
  const fixed = pubTot!==undefined ? +pubTot : (ov!==undefined && ov!=="" && ov!==null ? +ov : null);
  return {ph,lines,items,rush,price:fixed!==null?fixed:items,overridden:fixed!==null};
}
function linesText(r){ return r.lines.map(l=>`${l.label}${l.qty>1?` ×${l.qty}`:""} ${l.included?"(รวมแล้ว)":fmt(l.amt)}`).join(" · "); }
function chExtraAmt(c,x,actCount){
  if(c.extraAmt?.[x.id]!==undefined) return +c.extraAmt[x.id];
  if(x.type==="fixed") return +x.value||0;
  if(x.type==="perPhase") return actCount*(+x.value||0);
  if(x.type==="opportunity") return rnd((+c.price||0)*(+x.jobs||0)*(+x.months||0)*(+x.likelihood||0)/100);
  return 0;
}
function calc(c){
  const P=+c.price||0;
  const rows=S.phases.map(ph=>({...phaseCalc(c,ph),on:phOn(c,ph)}));
  const act=rows.filter(r=>r.on);
  const content=act.reduce((s,r)=>s+r.price,0);
  const full=S.settings.bundleOn && act.length===S.phases.length && S.phases.length>1;
  const bundle=full?rnd(content*(+S.settings.bundlePct||0)/100):0;
  const net=content-bundle;
  const rush=act.reduce((s,r)=>s+r.rush,0);
  const extras=act.length?S.extras.filter(x=>x.on&&!isDeal(x)).map(x=>({x,amt:chExtraAmt(c,x,act.length)})).filter(e=>e.amt):[];
  const extra=extras.reduce((s,e)=>s+e.amt,0);
  return {P,rows,act,content,bundle,net,rush,extras,extra,total:net+rush+extra};
}
function tierFor(n){ let pct=0; [...S.settings.tiers].sort((a,b)=>a.min-b.min).forEach(t=>{ if(n>=+t.min) pct=+t.pct; }); return S.settings.tierOn?pct:0; }
function dealExtras(base){ return S.extras.filter(x=>x.on&&isDeal(x)).map(x=>({x,amt:x.type==="dealPct"?rnd(base*(+x.value||0)/100):(+x.value||0)})).filter(e=>e.amt); }
function vatOf(pre,list){
  const vp=(+S.settings.vatPct||0)/100;
  if(S.settings.vatMode==="all") return pre*vp;
  if(S.settings.vatMode==="channel"){ const base=list.reduce((s,x)=>s+x.t,0); const vb=list.filter(x=>x.c.vat).reduce((s,x)=>s+x.t,0); return base?pre*(vb/base)*vp:0; }
  return 0;
}
function quote(){
  const sel=S.channels.filter(c=>c.on && picked(c) && S.phases.some(p=>phOn(c,p)));
  const list=sel.map(c=>({c,k:calc(c)}));
  const net=list.reduce((s,x)=>s+x.k.net,0);
  const rush=list.reduce((s,x)=>s+x.k.rush,0);
  const extra=list.reduce((s,x)=>s+x.k.extra,0);
  const sub=net+rush+extra;                      // Σ channel totals
  const pct=tierFor(sel.length);
  const disc=rnd(net*pct/100);
  const deal=dealExtras(net-disc);              // once per deal, on content after discounts
  const dealAmt=deal.reduce((s,e)=>s+e.amt,0);
  const manual=+S.settings.manualDiscount||0;
  const pre=sub-disc+dealAmt-manual;
  const vat=vatOf(pre,list.map(x=>({c:x.c,t:x.k.total})));
  const reachSum=list.reduce((s,x)=>s+reach(x.c),0);
  const likes=list.reduce((s,x)=>s+x.c.platforms.reduce((a,p)=>a+(+p.likes||0),0),0);
  return {sel,list,net,rush,extra,sub,pct,disc,deal,dealAmt,manual,pre,vat,grand:pre+vat,reach:reachSum,likes};
}
// One phase bought on its own by every selected channel that offers it.
function phaseSummary(ph){
  const perPh=S.extras.filter(x=>x.on&&x.type==="perPhase");
  const rows=S.channels.filter(c=>c.on&&picked(c)&&c.ph?.[ph.id]!==false).map(c=>{
    const r=phaseCalc(c,ph); const ex=perPh.map(x=>({x,amt:+x.value||0})).filter(e=>e.amt);
    const extra=ex.reduce((s,e)=>s+e.amt,0);
    return {c,r,price:r.price,rush:r.rush,ex,extra,total:r.price+r.rush+extra}; });
  const content=rows.reduce((s,r)=>s+r.price,0), rush=rows.reduce((s,r)=>s+r.rush,0), extra=rows.reduce((s,r)=>s+r.extra,0);
  const pct=tierFor(rows.length), disc=rnd(content*pct/100);
  const deal=dealExtras(content-disc), dealAmt=deal.reduce((s,e)=>s+e.amt,0);
  const pre=content+rush+extra-disc+dealAmt;
  const vat=vatOf(pre,rows.map(r=>({c:r.c,t:r.total})));
  return {ph,rows,content,rush,extra,pct,disc,deal,dealAmt,pre,vat,grand:pre+vat};
}
function selBar(q){
  const total=S.channels.filter(c=>c.on).length, nx=nextTier(q.sel.length);
  return `<div class="selbar" role="region" aria-label="แพ็กที่เลือก"><div class="max">
    <div class="sb-main"><span class="sb-n"><b class="num">${q.sel.length}</b>/${total} ช่อง</span>
      <span class="sb-p">${q.pct?`ลด ${q.pct}%`:"ราคาปกติ"}${nx?`<small> · +${nx.need} ช่อง ลด ${nx.pct}%</small>`:""}</span>
      <span class="sb-t num">฿${fmt(q.pre)}<small> ก่อน VAT</small></span></div>
    <div class="sb-ph">${S.phases.map(p=>`<button class="small ${unpickPh.has(p.id)?"":"on"}" data-act="pickPh" data-id="${esc(p.id)}" aria-pressed="${!unpickPh.has(p.id)}">${esc(p.name.split(":")[0])}</button>`).join("")}
      <button class="small ghost" data-act="pickAll">เลือกทั้งหมด</button>${q.sel.length?`<button class="small ghost" data-act="pickNone">ล้าง</button>`:""}</div>
  </div></div>`;
}
function focusPh(){ return S.phases.find(p=>p.id===(phaseView||S.settings.focusPhase)) || S.phases[S.phases.length-1]; }
function dealNote(){ const d=S.extras.filter(x=>x.on&&isDeal(x)); return d.length?`${d.map(x=>x.label+(x.type==="dealPct"?` ${x.value}%`:"")).join(" และ ")} คิดครั้งเดียวต่อดีล จากยอดหลังหักส่วนลด`:""; }
function byPhaseHTML(){
  if(!S.phases.length) return "";
  const q=quote(), fp=focusPh(), sums=S.phases.map(phaseSummary), cur=sums.find(x=>x.ph.id===fp.id);
  const vatOn=S.settings.vatMode!=="none";
  const hasRush=cur.rush>0, hasEx=cur.extra>0;
  const detailRows=cur.rows.map(r=>`<tr><td><b>${esc(r.c.name)}</b><div class="likes">${esc(linesText(r.r))}</div></td><td class="r num">${fmt(r.price)}</td>${hasRush?`<td class="r num">${r.rush?fmt(r.rush):"–"}</td>`:""}${hasEx?`<td class="r num">${r.extra?fmt(r.extra):"–"}</td>`:""}<td class="r num"><b>${fmt(r.total)}</b></td></tr>`).join("");
  const dc=2+(hasRush?1:0)+(hasEx?1:0);
  const saving=sums.reduce((s,x)=>s+x.pre,0)-(q.pre+q.manual);
  const fc=x=>x.ph.id===fp.id?"focus":"";
  return `<section class="block gutter" id="by-phase"><div class="max">
    <div class="block-head"><h2>Price by Phase</h2><p>เลือกดูราคารวมทุกช่องทีละ Phase พร้อมรายการงานของแต่ละช่อง${dealNote()?` · ${esc(dealNote())}`:""}</p></div>
    <div class="phase-tabs" role="tablist" aria-label="เลือก Phase">${S.phases.map(p=>`<button role="tab" aria-selected="${p.id===fp.id}" data-act="phaseView" data-ph="${esc(p.id)}">${esc(p.name)}</button>`).join("")}</div>
    <div class="pv">
      <div class="pv-total">
        <span class="eyebrow" style="color:inherit;opacity:.7">${esc(fp.dates)} · ${cur.rows.length} ช่อง</span>
        <h3>${esc(fp.name)}</h3>
        <span class="big num">฿${fmt(cur.pre)}</span><span class="small-note">ถ้าซื้อเฉพาะ Phase นี้ · ก่อน VAT</span>
        <div class="ln"><span>ค่าคอนเทนต์ ${cur.rows.length} ช่อง</span><span class="num">${fmt(cur.content)}</span></div>
        ${cur.rush?`<div class="ln"><span>ค่าเร่งงาน</span><span class="num">${fmt(cur.rush)}</span></div>`:""}
        ${cur.extra?`<div class="ln"><span>ค่าเพิ่มต่อ Phase</span><span class="num">${fmt(cur.extra)}</span></div>`:""}
        ${cur.disc?`<div class="ln"><span>ส่วนลดแพ็ก ${cur.rows.length} ช่อง ${cur.pct}%</span><span class="num">−${fmt(cur.disc)}</span></div>`:""}
        ${cur.deal.map(e=>`<div class="ln"><span>${esc(e.x.label)}${e.x.type==="dealPct"?` ${e.x.value}%`:""}</span><span class="num">${fmt(e.amt)}</span></div>`).join("")}
        ${vatOn?`<div class="ln"><span>VAT ${S.settings.vatPct}%</span><span class="num">${fmt2(cur.vat)}</span></div><div class="ln g"><span>รวมทั้งสิ้น</span><span class="num">${fmt2(cur.grand)}</span></div>`:""}
        <ul>${(fp.items||[]).map(it=>{const t=typeOf(it.type);return `<li>${esc(it.label||t.label)}${+it.qty>1?` ×${it.qty}`:""}${t.included?" · รวมในราคาแล้ว":""}</li>`;}).join("")}</ul>
      </div>
      <div class="scroll"><table>
        <thead><tr><th>ช่อง · รายการ</th><th class="r">${esc(fp.name.split(":")[0])}</th>${hasRush?`<th class="r">ค่าเร่งงาน</th>`:""}${hasEx?`<th class="r">ค่าเพิ่ม</th>`:""}<th class="r">รวม</th></tr></thead>
        <tbody>${detailRows||`<tr><td colspan="${dc+1}">ยังไม่มีช่องที่เสนอ Phase นี้</td></tr>`}</tbody>
        <tfoot><tr><td colspan="${dc}">รวม</td><td class="r num">${fmt(cur.content+cur.rush+cur.extra)}</td></tr>
        ${cur.disc?`<tr><td colspan="${dc}">ส่วนลดแพ็ก ${cur.rows.length} ช่อง ${cur.pct}%</td><td class="r num">−${fmt(cur.disc)}</td></tr>`:""}
        ${cur.deal.map(e=>`<tr><td colspan="${dc}">${esc(e.x.label)}${e.x.type==="dealPct"?` ${e.x.value}%`:""} (ครั้งเดียว)</td><td class="r num">${fmt(e.amt)}</td></tr>`).join("")}
        <tr class="grand"><td colspan="${dc}">สุทธิก่อน VAT</td><td class="r num">${fmt(cur.pre)}</td></tr></tfoot>
      </table></div>
    </div>
    <h3 class="sub">เทียบทุก Phase</h3>
    <div class="scroll"><table class="matrix">
      <thead><tr><th>ช่อง</th>${S.phases.map(p=>`<th class="r ${p.id===fp.id?"focus":""}">${esc(p.name)}</th>`).join("")}<th class="r">${unpickPh.size?"รวม Phase ที่เลือก":"ครบทุก Phase"}</th></tr></thead>
      <tbody>${q.list.map(({c,k})=>`<tr><td><b>${esc(c.name)}</b></td>${sums.map(x=>{const r=x.rows.find(r=>r.c===c);return `<td class="r num ${fc(x)}">${r?fmt(r.total):"–"}</td>`;}).join("")}<td class="r num"><b>${fmt(k.total)}</b></td></tr>`).join("")}</tbody>
      <tfoot>
        <tr><td>รวม</td>${sums.map(x=>`<td class="r num ${fc(x)}">${fmt(x.content+x.rush+x.extra)}</td>`).join("")}<td class="r num">${fmt(q.sub)}</td></tr>
        <tr><td>ส่วนลดแพ็กหลายช่อง</td>${sums.map(x=>`<td class="r num ${fc(x)}">${x.disc?`−${fmt(x.disc)} (${x.pct}%)`:"–"}</td>`).join("")}<td class="r num">${q.disc?`−${fmt(q.disc)} (${q.pct}%)`:"–"}</td></tr>
        ${S.extras.filter(x=>x.on&&isDeal(x)).map(x=>`<tr><td>${esc(x.label)} (ครั้งเดียว)</td>${sums.map(s=>{const e=s.deal.find(e=>e.x.id===x.id);return `<td class="r num ${fc(s)}">${e?fmt(e.amt):"–"}</td>`;}).join("")}<td class="r num">${fmt(q.deal.find(e=>e.x.id===x.id)?.amt||0)}</td></tr>`).join("")}
        ${q.manual?`<tr><td>${esc(S.settings.manualDiscountLabel)}</td>${sums.map(x=>`<td class="r ${fc(x)}">–</td>`).join("")}<td class="r num">−${fmt(q.manual)}</td></tr>`:""}
        <tr class="grand"><td>สุทธิก่อน VAT</td>${sums.map(x=>`<td class="r num">${fmt(x.pre)}</td>`).join("")}<td class="r num">${fmt(q.pre)}</td></tr>
      </tfoot></table></div>
    ${saving>0?`<p class="save-note">ซื้อครบทุก Phase ประหยัดกว่าซื้อแยกทีละ Phase <b class="num">฿${fmt(saving)}</b></p>`:""}
  </div></section>`;
}

/* =================== site render =================== */
function applyBrand(){
  const b=S.brand, r=document.documentElement.style;
  r.setProperty("--primary",b.primary); r.setProperty("--accent",b.accent); r.setProperty("--ink",b.ink);
  r.setProperty("--paper",b.paper); r.setProperty("--soft",b.soft);
  r.setProperty("--g1",b.gray1||"#717171"); r.setProperty("--g2",b.gray2||"#A2A3A2");
  r.setProperty("--display",`"${b.latinFont||"Barlow Condensed"}","${b.displayFont}","IBM Plex Sans Thai",system-ui,sans-serif`);
}
function avatarHTML(c,cls="avatar"){
  if(c.avatar) return `<img class="${cls}" src="${esc(c.avatar)}" alt="">`;
  const ini=(c.name||"?").trim().slice(0,2).toUpperCase();
  return `<div class="${cls}" aria-hidden="true">${esc(ini)}</div>`;
}
function wordmark(){
  const b=S.brand;
  return b.logo ? `<a class="wordmark" href="#top"><img src="${esc(b.logo)}" alt="${esc(b.name)}"></a>` : `<a class="wordmark" href="#top">${esc(b.name)}<span class="dot">.</span></a>`;
}
function renderSite(){
  applyBrand();
  const q=quote(), m=S.meta;
  const title=esc(m.campaign).replace(/\(([^)]+)\)/,'<span class="hl">($1)</span>');
  const cards=(adminOpen?S.channels:S.channels.filter(c=>c.on)).map(c=>{
    const k=calc(c);
    const pf=c.platforms.map(p=>`<div class="pf-row"><span class="pf-tag ${esc(p.p)}">${esc(p.p)}</span>${p.url?`<a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.handle||p.url)}</a>`:`<span>${esc(p.handle)}</span>`}<span class="num">${p.followers?compact(p.followers):"–"}${p.likes?` <span class="likes">· ${compact(p.likes)} likes</span>`:""}</span></div>`).join("");
    const fpid=focusPh()?.id; const rows=k.act.map(r=>`<div class="row ${r.ph.id===fpid?"fp":""}"><span>${esc(r.ph.name)}</span><span class="num">${fmt(r.price)}</span></div><div class="items-line">${esc(linesText(r))}${r.overridden?" · ราคาพิเศษ":""}</div>`).join("");
    const on=picked(c);
    return `<article class="card ${c.on?"":"off"} ${on?"":"unpicked"}" id="ch-${esc(c.id)}">
      <div class="card-top">${avatarHTML(c)}<div style="min-width:0;flex:1"><h3>${esc(c.name)}</h3>${c.niche?`<div class="niche">${esc(c.niche)}</div>`:""}${c.note?`<div class="note">${esc(c.note)}</div>`:""}</div>${!adminOpen?`<button class="pick ${on?"on":""}" data-act="pickCh" data-id="${esc(c.id)}" aria-pressed="${on}">${on?"✓ เลือกแล้ว":"+ เลือก"}</button>`:""}</div>
      <div class="reach"><span class="v num">${compact(reach(c))}</span><span class="l">ผู้ติดตามรวม<br>${c.platforms.length} แพลตฟอร์ม</span></div>
      <div class="pf">${pf}</div>
      <div class="prices">${rows}
        ${k.bundle?`<div class="row minus"><span>ส่วนลดรับครบทุก Phase</span><span class="num">−${fmt(k.bundle)}</span></div>`:""}
        ${k.rush?`<div class="row"><span>ค่าเร่งงาน</span><span class="num">${fmt(k.rush)}</span></div>`:""}
        ${k.extras.map(e=>`<div class="row"><span>${esc(e.x.label)}</span><span class="num">${fmt(e.amt)}</span></div>`).join("")}
        <div class="total"><span class="startfrom">${k.P?`1 คลิปเริ่มต้น ฿${fmt(k.P)}`:""}</span><b class="num">฿${fmt(k.total)}</b></div>
      </div></article>`;
  }).join("");
  const tiers=[...S.settings.tiers].sort((a,b)=>a.min-b.min);
  const tierHTML=S.settings.tierOn?tiers.map((t,i)=>{ const nx=tiers[i+1]; const range=nx?(nx.min-1>t.min?`${t.min}–${nx.min-1} ช่อง`:`${t.min} ช่อง`):`${t.min}+ ช่อง`; const act=q.sel.length>=t.min&&(!nx||q.sel.length<nx.min);
    const sh=tiers.length>1?Math.round(i/(tiers.length-1)*100):0; const dark=sh>=55;
    return `<div class="tier ${act?"active":""} ${dark?"dark":""}" style="background:color-mix(in srgb,var(--ink) ${sh}%,var(--paper))"><span class="eyebrow">${range}</span><span class="pct">${t.pct?`−${t.pct}%`:"ราคาปกติ"}</span>${act?`<span class="you">แพ็กที่เสนอ (${q.sel.length} ช่อง)</span>`:""}</div>`; }).join(""):"";
  const extraCols=S.extras.filter(x=>x.on&&!isDeal(x));
  const sumRows=q.list.map(({c,k})=>`<tr><td><b>${esc(c.name)}</b><div class="likes">${esc(mainHandle(c))}</div></td><td class="r num">${compact(reach(c))}</td>${S.phases.map(ph=>{const r=k.rows.find(r=>r.ph.id===ph.id);return `<td class="r num">${r.on?fmt(r.price):"–"}</td>`;}).join("")}<td class="r num">${k.bundle?"−"+fmt(k.bundle):"–"}</td><td class="r num">${k.rush?fmt(k.rush):"–"}</td>${extraCols.map(x=>{const e=k.extras.find(e=>e.x.id===x.id);return `<td class="r num">${e?fmt(e.amt):"–"}</td>`;}).join("")}<td class="r num"><b>${fmt(k.total)}</b></td></tr>`).join("");
  const cols=5+S.phases.length+extraCols.length;
  const vatLabel=S.settings.vatMode==="none"?"":S.settings.vatMode==="all"?`VAT ${S.settings.vatPct}%`:`VAT ${S.settings.vatPct}% (เฉพาะช่องที่ออกใบกำกับ)`;
  $("#app").innerHTML=`
  <header class="topbar gutter" id="top"><div class="max">
    ${wordmark()}
    <nav class="nav" aria-label="เมนู"><a href="#by-phase">By Phase</a><a href="#channels">Channels</a><a href="#packages">Packages</a><a href="#phases">Deliverables</a><a href="#summary">Summary</a></nav>
    <div class="actions">
      <button class="small" data-act="copyText">คัดลอกข้อความ</button>
      <button class="small" data-act="toggleMenu" aria-expanded="${menuOpen}">Google Sheets ▾</button>
      <button class="small solid" data-act="openQuote">ใบเสนอราคา</button>
      ${menuOpen?`<div class="menu" role="menu"><button data-act="copyTSV" role="menuitem">คัดลอกตาราง → วางใน Google Sheets</button><button data-act="xlsx" role="menuitem">ดาวน์โหลดไฟล์ .xlsx (เปิดใน Sheets ได้)</button><button data-act="csv" role="menuitem">ดาวน์โหลด .csv</button></div>`:""}
    </div></div></header>
  <section class="hero gutter"><div class="max">
    <div class="hero-grid"><div>
    <span class="kicker">Creator proposal · <b>${esc(m.client)}</b> × ${esc(m.brand)}</span>
    <h1>${title}</h1>
    ${m.intro?`<p class="lead">${esc(m.intro)}</p>`:""}</div>
    <div class="motif" aria-hidden="true"><i><i><i></i></i></i></div></div>
    <div class="stats">
      <div class="stat"><span class="v num">${compact(q.reach)}</span><span class="l">ผู้ติดตามรวมทุกแพลตฟอร์ม</span></div>
      <div class="stat"><span class="v num">${q.sel.length}</span><span class="l">ช่องครีเอเตอร์</span></div>
      <div class="stat"><span class="v num">${compact(q.likes)}</span><span class="l">ยอดไลก์รวมบน TikTok</span></div>
      <div class="stat"><span class="v num pink">฿${compact(q.pre)}</span><span class="l">ราคาแพ็กสุทธิ (ก่อน VAT)</span></div>
    </div>
  </div></section>
  ${byPhaseHTML()}
  <section class="block gutter alt" id="channels"><div class="max">
    <div class="block-head"><h2>Our Channels</h2><p>กด “เลือก” เพื่อจัดแพ็กเอง ราคาทั้งหน้าคำนวณใหม่ทันที · ยอดผู้ติดตามรวม TikTok, Instagram, YouTube และ Facebook</p></div>
    <div class="cards">${cards}</div>
  </div></section>
  ${S.settings.tierOn?`<section class="block gutter" id="packages"><div class="max">
    <div class="block-head"><h2>ยิ่งเลือกหลายช่อง ยิ่งคุ้ม</h2><p>ส่วนลดขั้นบันไดคิดจากค่าคอนเทนต์รวม ไม่รวมค่าเร่งงาน${dealNote()?` · ${esc(dealNote())}`:""}</p></div>
    <div class="tiers">${tierHTML}</div>${(()=>{ const n=q.sel.length, nx=nextTier(n); return `<p class="tier-hint">ตอนนี้เลือก <b>${n} ช่อง</b> ${q.pct?`ได้ส่วนลด <b>${q.pct}%</b> (−฿${fmt(q.disc)})`:"ยังไม่มีส่วนลดแพ็ก"}${nx?` · เลือกเพิ่มอีก <b>${nx.need} ช่อง</b> ลดเป็น <b>${nx.pct}%</b>`:""}</p>`; })()}</div></section>`:""}
  <section class="block gutter alt" id="phases"><div class="max">
    <div class="block-head"><h2>Deliverables</h2><p>งานที่ครีเอเตอร์แต่ละช่องทำในแต่ละ Phase</p></div>
    <div class="phases">${S.phases.map(p=>`<article class="phase"><span class="dates">${esc(p.dates)}</span><h3>${esc(p.name)}</h3><ul>${p.deliverables.split("\n").filter(Boolean).map(l=>`<li>${esc(l)}</li>`).join("")}</ul>${(p.items||[]).some(it=>typeOf(it.type).included)?`<p class="incl">รวมในราคาแล้ว: ${esc(p.items.filter(it=>typeOf(it.type).included).map(it=>it.label||typeOf(it.type).label).join(" · "))}</p>`:""}</article>`).join("")}</div>
  </div></section>
  <section class="block gutter" id="summary"><div class="max">
    <div class="block-head"><h2>Summary</h2><p>ราคาเป็นบาท · เสนอวันที่ ${esc(m.date)} · ราคายืนถึง ${esc(m.valid)}</p></div>
    <div class="scroll"><table>
      <thead><tr><th>ช่อง</th><th class="r">ผู้ติดตาม</th>${S.phases.map(p=>`<th class="r">${esc(p.name.split(":")[0])}</th>`).join("")}<th class="r">ลดครบ Phase</th><th class="r">ค่าเร่งงาน</th>${extraCols.map(x=>`<th class="r">${esc(x.label)}</th>`).join("")}<th class="r">รวม</th></tr></thead>
      <tbody>${sumRows||`<tr><td colspan="${cols}">ยังไม่ได้เลือกช่อง</td></tr>`}</tbody>
      <tfoot>
        <tr><td colspan="${cols-1}">รวม ${q.sel.length} ช่อง</td><td class="r num">${fmt(q.sub)}</td></tr>
        ${q.disc?`<tr><td colspan="${cols-1}">ส่วนลดแพ็ก ${q.sel.length} ช่อง ${q.pct}%</td><td class="r num">−${fmt(q.disc)}</td></tr>`:""}
        ${q.deal.map(e=>`<tr><td colspan="${cols-1}">${esc(e.x.label)}${e.x.type==="dealPct"?` ${e.x.value}% (คิดครั้งเดียวจากยอดหลังส่วนลด)`:" (ครั้งเดียว)"}</td><td class="r num">${fmt(e.amt)}</td></tr>`).join("")}
        ${q.manual?`<tr><td colspan="${cols-1}">${esc(S.settings.manualDiscountLabel)}</td><td class="r num">−${fmt(q.manual)}</td></tr>`:""}
        <tr><td colspan="${cols-1}">ราคาสุทธิก่อน VAT</td><td class="r num">${fmt(q.pre)}</td></tr>
        ${vatLabel?`<tr><td colspan="${cols-1}">${vatLabel}</td><td class="r num">${fmt2(q.vat)}</td></tr><tr class="grand"><td colspan="${cols-1}">ยอดรวมทั้งสิ้น</td><td class="r num">${fmt2(q.grand)}</td></tr>`:""}
      </tfoot></table></div>
    <h3 style="margin:34px 0 12px;font-size:22px">เงื่อนไข</h3>
    <ul class="terms">${S.terms.split("\n").filter(l=>l.trim()).map(l=>`<li>${esc(l)}</li>`).join("")}</ul>
  </div></section>
  <footer class="gutter"><div class="max">
    <div><div class="big">${S.brand.logo?`<img src="${esc(S.brand.logo)}" alt="${esc(S.brand.name)}">`:`${esc(S.brand.name)}<span style="color:var(--accent)">.</span>`}${S.brand.logo2?`<img class="l2" src="${esc(S.brand.logo2)}" alt="">`:""}</div></div>
    <div class="contact"><span>${esc(S.brand.tagline)}</span><span class="selectable">${esc(S.brand.contactEmail)}</span><span class="selectable">${esc(S.brand.contactPhone)}</span>${S.brand.website?`<a href="${esc(S.brand.website)}" target="_blank" rel="noopener">${esc(S.brand.website.replace(/^https?:\/\//,""))}</a>`:""}</div>
  </div></footer>
  ${!adminOpen?selBar(q):""}`;
}

/* =================== admin =================== */
const TABS=[["channels","ช่อง"],["rates","รายการ & เรท"],["phases","Phase & รายการงาน"],["pricing","ส่วนลด & ค่าเพิ่ม"],["quote","ใบเสนอราคา"],["content","หัวเรื่อง & เงื่อนไข"],["brand","แบรนด์ & บริษัท"],["data","ข้อมูล"]];
function fIn(path,label,opts={}){
  const v=getPath(path); const id="f_"+path.replace(/\./g,"_");
  const attrs=`id="${id}" data-bind="${path}" ${opts.num?"data-num":""} ${opts.pct?"data-pct":""}`;
  let ctl;
  if(opts.area) ctl=`<textarea ${attrs} rows="${opts.rows||3}">${esc(v)}</textarea>`;
  else if(opts.select) ctl=`<select ${attrs}>${opts.select.map(([val,t])=>`<option value="${esc(val)}" ${String(v)===String(val)?"selected":""}>${esc(t)}</option>`).join("")}</select>`;
  else if(opts.color) ctl=`<input type="color" ${attrs} value="${esc(v)}">`;
  else ctl=`<input ${opts.type?`type="${opts.type}"`:""} ${attrs} value="${esc(opts.pct?Math.round((+v||0)*100):v)}" ${opts.ph?`placeholder="${esc(opts.ph)}"`:""}>`;
  return `<div class="f"><label for="${id}">${esc(label)}</label>${ctl}</div>`;
}
function fChk(path,label){ const id="f_"+path.replace(/\./g,"_"); return `<label class="chk" for="${id}"><input type="checkbox" id="${id}" data-bind="${path}" data-bool ${getPath(path)?"checked":""}> ${esc(label)}</label>`; }

function tabChannels(){
  return `<p class="help">แก้ได้ทุกช่อง: ราคา 1 คลิป ค่าเร่ง แพลตฟอร์ม/ยอดผู้ติดตาม (พิมพ์ 808.5K หรือ 1.2M ได้) ราคาต่อ Phase ที่อยากกำหนดเอง และรูปโปรไฟล์</p>
  ${S.channels.map((c,i)=>{ const k=calc(c); return `<details class="panel" ${i===0?"open":""}>
    <summary>${avatarHTML(c,"mini-av")}<div class="grow" style="flex:1;min-width:0"><b>${esc(c.name)}</b><div class="help">${compact(reach(c))} ผู้ติดตาม · 1 คลิป ฿${fmt(c.price)} · รวม ฿${fmt(k.total)}</div></div><label class="chk" data-stop><input type="checkbox" data-bind="channels.${i}.on" data-bool ${c.on?"checked":""} aria-label="เสนอช่องนี้"> เสนอ</label></summary>
    <div class="grid2">${fIn(`channels.${i}.name`,"ชื่อช่อง")}${fIn(`channels.${i}.niche`,"ประเภทคอนเทนต์")}</div>
    ${fIn(`channels.${i}.note`,"หมายเหตุบนการ์ด (เช่น ลง IG เท่านั้น)")}
    <div class="grid3">${fIn(`channels.${i}.price`,"ราคา 1 คลิป (฿)",{num:1,type:"text"})}${fIn(`channels.${i}.rush`,"ค่าเร่ง/คลิป (฿)",{num:1,type:"text"})}<div class="f"><span class="lab">ภาษี</span>${fChk(`channels.${i}.vat`,"ออกใบกำกับ VAT")}</div></div>
    <div class="panel-head"><span class="lab">รูปโปรไฟล์</span><label class="chk" style="cursor:pointer"><input type="file" accept="image/*" data-avatar="${i}" style="width:auto;border:0;padding:0"></label>${c.avatar?`<button class="small danger" data-act="clearAvatar" data-i="${i}">ลบรูป</button>`:""}</div>
    <span class="lab">แพลตฟอร์ม & ยอดผู้ติดตาม</span>
    ${c.platforms.map((p,j)=>`<div class="rowline pf-edit">
      <select data-bind="channels.${i}.platforms.${j}.p" aria-label="แพลตฟอร์ม">${["TikTok","Instagram","YouTube","Facebook","X","Twitch","Other"].map(o=>`<option ${p.p===o?"selected":""}>${o}</option>`).join("")}</select>
      <input data-bind="channels.${i}.platforms.${j}.handle" value="${esc(p.handle)}" placeholder="@handle" aria-label="handle">
      <input data-bind="channels.${i}.platforms.${j}.url" value="${esc(p.url)}" placeholder="ลิงก์" aria-label="ลิงก์">
      <input data-bind="channels.${i}.platforms.${j}.followers" data-num value="${esc(compact(p.followers))}" placeholder="ผู้ติดตาม" aria-label="ผู้ติดตาม">
      <input data-bind="channels.${i}.platforms.${j}.likes" data-num value="${p.likes?esc(compact(p.likes)):""}" placeholder="ไลก์" aria-label="ยอดไลก์">
      <button class="x" data-act="delPf" data-i="${i}" data-j="${j}" aria-label="ลบแพลตฟอร์ม">×</button></div>`).join("")}
    <div><button class="small" data-act="addPf" data-i="${i}">+ แพลตฟอร์ม</button></div>
    <span class="lab">เรทรายการของช่องนี้ (เว้นว่าง = ใช้สูตรในแท็บ “รายการ & เรท”)</span>
    <div class="grid3">${(S.itemTypes||[]).map(ty=>`<div class="f"><label>${esc(ty.label)}${ty.unit?` /${esc(ty.unit)}`:""}</label><input data-bind="channels.${i}.rates.${ty.id}" data-rate value="${c.rates?.[ty.id]??""}" placeholder="${ty.included?"รวมแล้ว (0)":fmt(autoRate(c,ty))}"></div>`).join("")}</div>
    <span class="lab">Phase ที่เสนอ & ราคารวม Phase (เว้นว่าง = รวมจากรายการ)</span>
    ${k.rows.map(r=>`<div class="rowline" style="grid-template-columns:auto 1fr 130px">
      <input type="checkbox" data-bind="channels.${i}.ph.${r.ph.id}" data-bool ${r.on?"checked":""} aria-label="${esc(r.ph.name)}">
      <span style="font-size:14px">${esc(r.ph.name)} <span class="help" style="display:inline">${esc(linesText({...r,lines:r.lines}))}${r.rush?` · เร่ง ${fmt(r.rush)}`:""}</span></span>
      <input data-bind="channels.${i}.override.${r.ph.id}" data-override value="${c.override?.[r.ph.id]??""}" placeholder="${fmt(r.items)}" aria-label="ราคารวม Phase กำหนดเอง"></div>`).join("")}
    <div class="panel-head"><button class="small" data-act="moveCh" data-i="${i}" data-d="-1">↑ ขึ้น</button><button class="small" data-act="moveCh" data-i="${i}" data-d="1">↓ ลง</button><button class="small" data-act="dupCh" data-i="${i}">ทำสำเนา</button><span class="grow"></span><button class="small danger" data-act="delCh" data-i="${i}">ลบช่องนี้</button></div>
  </details>`;}).join("")}
  <div><button class="solid" data-act="addCh">+ เพิ่มช่อง</button></div>`;
}
function tabRates(){
  return `<p class="help">รายการงานที่ขายได้ (เหมือนเรทการ์ด) ราคาต่อช่อง = % ของราคา 1 คลิป แต่ไม่ต่ำกว่าขั้นต่ำ · ติ๊ก “รวมในราคา” สำหรับงานที่รวมอยู่ในค่าคลิปแล้ว (เช่น ไปร่วมงานพร้อมทีม+MC) · แก้ราคาเฉพาะช่องได้ในแท็บ “ช่อง”</p>
  ${(S.itemTypes||[]).map((ty,ti)=>`<div class="panel">
    <div class="rowline type-edit">
      <div class="f"><label>ชื่อรายการ</label><input data-bind="itemTypes.${ti}.label" value="${esc(ty.label)}"></div>
      <div class="f"><label>หน่วย</label><input data-bind="itemTypes.${ti}.unit" value="${esc(ty.unit||"")}"></div>
      <div class="f"><label>% ของ 1 คลิป</label><input data-bind="itemTypes.${ti}.ratio" data-pct value="${Math.round((+ty.ratio||0)*100)}"></div>
      <div class="f"><label>ขั้นต่ำ ฿</label><input data-bind="itemTypes.${ti}.floor" data-num value="${ty.floor||0}"></div>
    </div>
    <div class="panel-head">${fChk(`itemTypes.${ti}.included`,"รวมในราคาแล้ว (ไม่คิดเงินเพิ่ม)")}<span class="grow"></span><span class="help">ตัวอย่าง: ${esc(S.channels.slice(0,3).map(c=>`${c.name} ${ty.included?"0":fmt(rateOf(c,ty))}`).join(" · "))}</span><button class="x" data-act="delType" data-i="${ti}" aria-label="ลบรายการ">×</button></div>
    ${fIn(`itemTypes.${ti}.note`,"หมายเหตุภายใน (ลูกค้าไม่เห็น)")}
  </div>`).join("")}
  <div><button class="solid" data-act="addType">+ เพิ่มรายการ</button></div>`;
}
function tabPhases(){
  const opts=(S.itemTypes||[]).map(ty=>[ty.id,ty.label]);
  return `<p class="help">แต่ละ Phase ใส่รายการงานได้ไม่จำกัด ราคา Phase ของแต่ละช่อง = ผลรวม (เรทรายการของช่อง × จำนวน) · ติ๊ก “เร่ง” เพื่อบวกค่าเร่งงานของช่องต่อชิ้น</p>
  ${S.phases.map((p,pi)=>`<div class="panel">
    <div class="grid2">${fIn(`phases.${pi}.name`,"ชื่อ Phase")}${fIn(`phases.${pi}.dates`,"ช่วงวันที่")}</div>
    ${fIn(`phases.${pi}.deliverables`,"Deliverables ที่แสดงให้ลูกค้า (บรรทัดละ 1 ข้อ)",{area:1,rows:3})}
    <span class="lab">รายการงาน: ประเภท · ข้อความที่แสดง · จำนวน · เร่ง</span>
    ${(p.items||[]).map((it,ii)=>`<div class="rowline item-row">
      <select data-bind="phases.${pi}.items.${ii}.type" aria-label="ประเภท">${opts.map(([v,l])=>`<option value="${esc(v)}" ${it.type===v?"selected":""}>${esc(l)}</option>`).join("")}</select>
      <input data-bind="phases.${pi}.items.${ii}.label" value="${esc(it.label||"")}" placeholder="${esc(typeOf(it.type).label)}" aria-label="ข้อความ">
      <input data-bind="phases.${pi}.items.${ii}.qty" data-num value="${it.qty}" aria-label="จำนวน">
      <label class="chk"><input type="checkbox" data-bind="phases.${pi}.items.${ii}.rush" data-bool ${it.rush?"checked":""}> เร่ง</label>
      <button class="x" data-act="delPhItem" data-p="${pi}" data-c="${ii}" aria-label="ลบรายการ">×</button></div>`).join("")}
    <div class="panel-head"><button class="small" data-act="addPhItem" data-p="${pi}">+ รายการงาน</button><button class="small" data-act="movePhase" data-p="${pi}" data-d="-1">↑</button><button class="small" data-act="movePhase" data-p="${pi}" data-d="1">↓</button><span class="grow"></span><button class="small danger" data-act="delPhase" data-p="${pi}">ลบ Phase</button></div>
  </div>`).join("")}
  <div><button class="solid" data-act="addPhase">+ เพิ่ม Phase</button></div>`;
}
function tabPricing(){
  return `<div class="panel"><h3>ทั่วไป</h3>
    <div class="grid2">${fIn("settings.roundTo","ปัดราคาทีละ (฿)",{num:1})}${fIn("settings.vatPct","VAT (%)",{num:1})}</div>
    ${fChk("settings.showClipPrice","แสดงราคา 1 คลิปบนการ์ดให้ลูกค้าเห็น")}
    ${fIn("settings.focusPhase","Phase ที่ลูกค้าเห็นก่อน (หน้า Price by Phase)",{select:S.phases.map(p=>[p.id,p.name])})}
    ${fIn("settings.vatMode","คิด VAT แบบไหน",{select:[["all","ทั้งใบ (ออกใบเสนอในนามบริษัท)"],["channel","เฉพาะช่องที่ติ๊ก VAT"],["none","ไม่แสดง VAT"]]})}
  </div>
  <div class="panel"><h3>ส่วนลดรับครบทุก Phase (ต่อช่อง)</h3>${fChk("settings.bundleOn","เปิดใช้")}${fIn("settings.bundlePct","ลด (%)",{num:1})}</div>
  <div class="panel"><h3>ส่วนลดขั้นบันไดหลายช่อง</h3>${fChk("settings.tierOn","เปิดใช้")}
    ${S.settings.tiers.map((t,i)=>`<div class="rowline" style="grid-template-columns:1fr 1fr 30px"><div class="f"><label>ตั้งแต่ (ช่อง)</label><input data-bind="settings.tiers.${i}.min" data-num value="${t.min}"></div><div class="f"><label>ลด (%)</label><input data-bind="settings.tiers.${i}.pct" data-num value="${t.pct}"></div><button class="x" data-act="delTier" data-i="${i}" aria-label="ลบขั้น">×</button></div>`).join("")}
    <div><button class="small" data-act="addTier">+ เพิ่มขั้น</button></div></div>
  <div class="panel"><h3>ค่าเพิ่ม (กันแบรนด์ ซื้อขาด ฯลฯ)</h3>
    <p class="help">คิดครั้งเดียวต่อดีล: dealPct = % ของค่าคอนเทนต์หลังหักส่วนลด (เช่น กันแบรนด์ 20%, ซื้อขาด Asset 50%) · dealFixed = บาทต่อดีล<br>คิดครั้งเดียวต่อช่อง: fixed = บาท/ช่อง · perPhase = บาท × จำนวน Phase · opportunity = ประเมินกันแบรนด์จากงานที่เสียไป (ราคา 1 คลิป × งานหมวดเดียวกัน/เดือน × จำนวนเดือน × โอกาสที่คู่แข่งจะจ้าง %)</p>
    ${S.extras.map((x,i)=>`<div class="panel soft"><div class="panel-head">${fChk(`extras.${i}.on`,"เปิดใช้")}<span class="grow"></span><button class="x" data-act="delExtra" data-i="${i}" aria-label="ลบ">×</button></div>
      <div class="grid3">${fIn(`extras.${i}.label`,"ชื่อ")}${fIn(`extras.${i}.type`,"แบบ",{select:[["dealPct","dealPct (% ครั้งเดียวต่อดีล)"],["dealFixed","dealFixed (฿ ต่อดีล)"],["fixed","fixed (฿/ช่อง)"],["perPhase","perPhase (฿/Phase)"],["opportunity","opportunity (ประเมินกันแบรนด์)"]]})}${x.type==="opportunity"?"":fIn(`extras.${i}.value`,x.type==="dealPct"?"%":"บาท",{num:1})}</div>
      ${x.type==="opportunity"?`<div class="grid3">${fIn(`extras.${i}.jobs`,"งานหมวดเดียวกัน/เดือน",{num:1})}${fIn(`extras.${i}.months`,"ระยะกันแบรนด์ (เดือน)",{num:1})}${fIn(`extras.${i}.likelihood`,"โอกาสคู่แข่งจ้างช่วงนี้ (%)",{num:1})}</div><p class="help">ตัวอย่าง: ${esc(S.channels.slice(0,3).map(c=>`${c.name} ${fmt(chExtraAmt({...c,extraAmt:undefined},x,1))}`).join(" · "))}</p>`:""}
      ${fIn(`extras.${i}.note`,"เหตุผล/หมายเหตุภายใน (ลูกค้าไม่เห็น)",{area:1,rows:2})}</div>`).join("")}
    <div><button class="small" data-act="addExtra">+ ค่าเพิ่ม</button></div></div>
  <div class="panel"><h3>ส่วนลดพิเศษทั้งดีล</h3><div class="grid2">${fIn("settings.manualDiscountLabel","ชื่อ")}${fIn("settings.manualDiscount","จำนวน (฿)",{num:1})}</div></div>`;
}
function autoItems(){
  const q=quote(); const items=[];
  if(S.quote.mode==="byPhase"){
    S.phases.filter(p=>S.quote.includePh?.[p.id]!==false).map(phaseSummary).forEach(x=>{
      if(!x.rows.length) return;
      items.push({title:`${x.ph.name} — ${x.rows.length} ช่อง`,desc:x.rows.map(r=>`${r.c.name}: ${linesText(r.r)}${r.rush?` + เร่ง ${fmt(r.rush)}`:""}`).join("\n"),qty:1,unit:"งาน",price:x.content+x.rush+x.extra,_ph:x});
    });
    return items;
  }
  if(S.quote.mode==="phase"){
    q.list.forEach(({c,k})=>{
      k.act.forEach(r=>{ items.push({title:`${c.name} — ${r.ph.name}`,desc:linesText(r),qty:1,unit:"งาน",price:r.price}); if(r.rush) items.push({title:`${c.name} — ค่าเร่งงาน ${r.ph.name.split(":")[0]}`,desc:"",qty:1,unit:"รายการ",price:r.rush}); });
      if(k.bundle) items.push({title:`${c.name} — ส่วนลดรับครบทุก Phase`,desc:"",qty:1,unit:"รายการ",price:-k.bundle});
      k.extras.forEach(e=>items.push({title:`${c.name} — ${e.x.label}`,desc:"",qty:1,unit:"รายการ",price:e.amt}));
    });
  } else {
    q.list.forEach(({c,k})=>{
      const d=[...k.act.map(r=>`${r.ph.name} ${fmt(r.price)} (${linesText(r)})`), k.bundle?`ลดครบ Phase −${fmt(k.bundle)}`:"", k.rush?`ค่าเร่งงาน ${fmt(k.rush)}`:"", ...k.extras.map(e=>`${e.x.label} ${fmt(e.amt)}`)].filter(Boolean).join("\n");
      items.push({title:`ช่อง ${c.name}${mainHandle(c)?` (${mainHandle(c)})`:""}`,desc:d,qty:1,unit:"แพ็ก",price:k.total});
    });
  }
  return items;
}
function quoteData(){
  const q=quote();
  const custom=S.quote.useCustom;
  const items=custom?S.quote.customItems:autoItems();
  const sub=items.reduce((s,it)=>s+(+it.qty||0)*(+it.price||0),0);
  const lines=[];
  const dealLbl=e=>`${e.x.label}${e.x.type==="dealPct"?` ${e.x.value}%`:""}`;
  if(!custom && S.quote.mode==="byPhase"){
    const phs=items.map(it=>it._ph).filter(Boolean);
    phs.forEach(x=>{ if(x.disc) lines.push([`ส่วนลดแพ็ก ${x.ph.name.split(":")[0]} (${x.rows.length} ช่อง ${x.pct}%)`,-x.disc]); });
    dealExtras(phs.reduce((s,x)=>s+x.content-x.disc,0)).forEach(e=>lines.push([dealLbl(e),e.amt]));
    if(S.phases.every(p=>S.quote.includePh?.[p.id]!==false)){ const save=(sub+lines.reduce((s,l)=>s+l[1],0))-(q.pre+q.manual); if(save>0) lines.push(["ส่วนลดซื้อครบทุก Phase",-save]); }
  } else if(!custom){
    if(q.disc) lines.push([`ส่วนลดแพ็ก ${q.sel.length} ช่อง ${q.pct}%`,-q.disc]);
    q.deal.forEach(e=>lines.push([dealLbl(e),e.amt]));
  }
  if(+S.settings.manualDiscount) lines.push([S.settings.manualDiscountLabel,-S.settings.manualDiscount]);
  const total=sub+lines.reduce((s,l)=>s+l[1],0);
  const vp=(+S.settings.vatPct||0)/100;
  let vat=0;
  if(S.settings.vatMode==="all") vat=total*vp;
  else if(S.settings.vatMode==="channel"){ vat = custom? total*vp : (q.pre? q.vat*(total/q.pre):0); }
  return {items,sub,lines,total,vat,grand:total+vat};
}
function tabQuote(){
  const qd=quoteData();
  return `<div class="panel"><h3>หัวใบเสนอราคา</h3>
    <div class="grid2">${fIn("quote.number","Quotation #")}${fIn("quote.date","วันที่")}</div>
    ${fIn("quote.project","Project",{area:1,rows:2})}
    ${fIn("quote.clientBlock","Quotation for (ชื่อ ที่อยู่ เลขผู้เสียภาษีลูกค้า)",{area:1,rows:4})}
    ${fIn("quote.sectionTitle","หัวตารางรายการ")}
    ${fIn("quote.notes","หมายเหตุ",{area:1,rows:5})}
    <div class="grid2">${fChk("quote.showSign","แสดงช่องลงนาม")}${fIn("quote.signName","ชื่อผู้เสนอราคา")}</div></div>
  <div class="panel"><h3>รายการในใบเสนอราคา</h3>
    ${fIn("quote.mode","รูปแบบรายการอัตโนมัติ",{select:[["channel","1 บรรทัดต่อช่อง"],["byPhase","1 บรรทัดต่อ Phase (รวมทุกช่อง)"],["phase","แยกทุก Phase ต่อช่อง"]]})}
    ${S.quote.mode==="byPhase"?`<div class="panel soft"><span class="lab">Phase ที่ใส่ในใบเสนอราคา</span>${S.phases.map(p=>`<label class="chk"><input type="checkbox" data-bind="quote.includePh.${p.id}" data-bool ${S.quote.includePh?.[p.id]!==false?"checked":""}> ${esc(p.name)}</label>`).join("")}</div>`:""}
    ${fChk("quote.useCustom","ใช้รายการที่แก้เอง (ไม่คำนวณอัตโนมัติ)")}
    ${S.quote.useCustom?`${S.quote.customItems.map((it,i)=>`<div class="panel soft">
        <div class="rowline item-edit"><input data-bind="quote.customItems.${i}.title" value="${esc(it.title)}" aria-label="รายการ"><input data-bind="quote.customItems.${i}.qty" data-num value="${it.qty}" aria-label="จำนวน"><input data-bind="quote.customItems.${i}.unit" value="${esc(it.unit)}" aria-label="หน่วย"><input data-bind="quote.customItems.${i}.price" data-num data-signed value="${it.price}" aria-label="ราคาต่อหน่วย"><button class="x" data-act="delItem" data-i="${i}" aria-label="ลบ">×</button></div>
        <textarea data-bind="quote.customItems.${i}.desc" rows="2" aria-label="รายละเอียด">${esc(it.desc)}</textarea></div>`).join("")}
      <div class="panel-head"><button class="small" data-act="addItem">+ รายการ</button><button class="small" data-act="genItems">ดึงรายการอัตโนมัติมาแก้ต่อ</button></div>
      <p class="help">โหมดแก้เอง: ส่วนลดขั้นบันไดไม่ถูกหักอัตโนมัติ ใส่เป็นรายการติดลบได้</p>`
     :`<p class="help">ตอนนี้ ${qd.items.length} รายการ · ยอดก่อน VAT ฿${fmt2(qd.total)}. กด “ใช้รายการที่แก้เอง” แล้ว “ดึงรายการอัตโนมัติมาแก้ต่อ” เพื่อแก้ข้อความ/ราคาแต่ละบรรทัด</p>`}
  </div>
  <div><button class="solid" data-act="openQuote">ดูตัวอย่าง & ดาวน์โหลด PDF</button></div>`;
}
function tabContent(){
  return `<div class="panel"><h3>หัวเรื่องหน้าเว็บ</h3>
    ${fIn("meta.campaign","ชื่อแคมเปญ")}
    <div class="grid2">${fIn("meta.client","ลูกค้า / เอเจนซี่")}${fIn("meta.brand","แบรนด์")}${fIn("meta.date","วันที่เสนอ")}${fIn("meta.valid","ราคายืนถึง")}</div>
    ${fIn("meta.intro","คำโปรย",{area:1,rows:3})}</div>
  <div class="panel"><h3>เงื่อนไข (บรรทัดละ 1 ข้อ)</h3>${fIn("terms","เงื่อนไข",{area:1,rows:10})}</div>`;
}
function tabBrand(){
  return `<div class="panel"><h3>CI หน้าเว็บ</h3>
    <div class="grid2">${fIn("brand.name","ชื่อแบรนด์ (wordmark)")}${fIn("brand.displayFont","ฟอนต์หัวเรื่อง",{select:[["Kanit","Kanit"],["Prompt","Prompt"],["Anuphan","Anuphan"],["IBM Plex Sans Thai","IBM Plex Sans Thai"]]})}</div>
    <div class="panel-head"><span class="lab">โลโก้ (PNG/SVG พื้นใส)</span><input type="file" accept="image/*" data-logo style="width:auto;border:0;padding:0">${S.brand.logo?`<button class="small danger" data-act="clearLogo">ลบโลโก้</button>`:""}</div>
    <div class="grid3">${fIn("brand.primary","สีหลัก",{color:1})}${fIn("brand.accent","สีเน้น",{color:1})}${fIn("brand.ink","สีตัวอักษร",{color:1})}${fIn("brand.paper","พื้นหลัง",{color:1})}${fIn("brand.soft","พื้นรอง",{color:1})}${fIn("brand.gray1","เทาเข้ม",{color:1})}${fIn("brand.gray2","เทาอ่อน",{color:1})}</div>
    ${fIn("brand.latinFont","ฟอนต์อังกฤษ/ตัวเลข",{select:[["Barlow Condensed","Barlow Condensed"],["Oswald","Oswald"],["IBM Plex Sans Thai","IBM Plex Sans (ปกติ)"]]})}
    <div class="panel-head"><span class="lab">โลโก้รอง (เช่น Futureboard)</span><input type="file" accept="image/*" data-logo2 style="width:auto;border:0;padding:0">${S.brand.logo2?`<button class="small danger" data-act="clearLogo2">ลบ</button>`:""}</div>
    ${fIn("brand.tagline","Tagline")}
    <div class="grid2">${fIn("brand.contactEmail","อีเมล")}${fIn("brand.contactPhone","โทร")}</div>${fIn("brand.website","เว็บไซต์")}</div>
  <div class="panel"><h3>ข้อมูลบริษัท (หัวใบเสนอราคา)</h3>
    <div class="grid2">${fIn("company.nameTh","ชื่อบริษัท (ไทย)")}${fIn("company.nameEn","ชื่อบริษัท (อังกฤษ)")}</div>
    ${fIn("company.address","ที่อยู่",{area:1,rows:3})}
    <div class="grid3">${fIn("company.taxId","เลขผู้เสียภาษี")}${fIn("company.email","อีเมล")}${fIn("company.phone","โทร")}</div></div>`;
}
function tabData(){
  return `<div class="panel"><h3>สำรอง / ใช้เป็นเทมเพลตลูกค้าอื่น</h3>
    <p class="help">ปุ่ม “บันทึก” จะบันทึกลงเซิร์ฟเวอร์ ลูกค้าที่เปิดลิงก์เห็นเวอร์ชันล่าสุด · ทำข้อเสนอให้ลูกค้าเจ้าใหม่ได้จากหน้ารายการ (ทำสำเนา) หรือดาวน์โหลด JSON เก็บเป็นสำรอง</p>
    <div class="panel-head"><button class="small" data-act="dlJSON">ดาวน์โหลด JSON</button><button class="small" data-act="copyJSON">คัดลอก JSON</button><label class="small" style="display:inline-flex;gap:6px;align-items:center">โหลดไฟล์ <input type="file" accept="application/json,.json" data-import style="width:auto;border:0;padding:0"></label></div>
    <textarea id="jsonBox" rows="6" placeholder="หรือวาง JSON ตรงนี้แล้วกดโหลด"></textarea>
    <div class="panel-head"><button class="small" data-act="pasteJSON">โหลดจากที่วาง</button><span class="grow"></span><button class="small danger" data-act="askReset">คืนค่าเป็นเทมเพลตตั้งต้น</button></div>
    <div id="resetBox" hidden class="banner"><span>ล้างค่าที่แก้ทั้งหมดกลับเป็นค่าเริ่มต้น?</span><button class="small" data-act="doReset">ยืนยัน</button><button class="small" data-act="cancelReset">ยกเลิก</button></div>
  </div>`;
}
function renderAdmin(){
  const root=$("#adminRoot");
  document.body.classList.toggle("admin-open",caps.canEdit&&adminOpen);
  if(!caps.canEdit){ root.innerHTML=""; return; }
  const scrollTop=$(".drawer-body")?.scrollTop||0;
  const openSet=[...document.querySelectorAll(".drawer-body details")].map(d=>d.open);
  const fab=`<div class="fab">${dirty?`<span class="dirty">ยังไม่บันทึก</span>`:""}${dirty?`<button class="pink" data-act="save">บันทึก</button>`:""}<button class="solid" data-act="toggleAdmin" aria-expanded="${adminOpen}">${adminOpen?"ปิด Backend":"Backend"}</button></div>`;
  if(!adminOpen){ root.innerHTML=fab; return; }
  const body={channels:tabChannels,rates:tabRates,phases:tabPhases,pricing:tabPricing,quote:tabQuote,content:tabContent,brand:tabBrand,data:tabData}[tab]();
  root.innerHTML=`<aside class="drawer" aria-label="Backend">
    <div class="drawer-head"><button class="small" data-act="goList">← รายการ</button><h2>Backend</h2><button class="small pink" data-act="save" ${dirty?"":"disabled"}>${dirty?"บันทึก":"บันทึกแล้ว"}</button><button class="small" data-act="toggleAdmin">ซ่อน</button></div>
    <div class="linkbar">
      <input data-rec="title" value="${esc(REC.title)}" aria-label="ชื่อในรายการ" placeholder="ชื่อในรายการ">
      <label class="chk"><input type="checkbox" data-rec="published" ${REC.published?"checked":""}> เปิดลิงก์ให้ลูกค้า</label>
      <div class="linkrow"><code class="selectable">${esc(clientURL(REC))}</code><button class="small" data-act="copyLink">คัดลอกลิงก์</button><a class="small btnlink" href="${esc(clientURL(REC))}" target="_blank" rel="noopener">เปิดดูแบบลูกค้า ↗</a><button class="small ghost" data-act="newLink" title="ลิงก์เดิมจะใช้ไม่ได้ทันที">สร้างลิงก์ใหม่</button></div>
      ${REC.published?"":`<p class="help">ลิงก์ยังปิดอยู่ ลูกค้าเปิดจะเจอหน้า “ไม่พบข้อเสนอ” ติ๊กเปิดแล้วกดบันทึก</p>`}
    </div>
    ${conflict?`<div class="banner" style="margin:10px 16px 0"><span>มีการบันทึกจากที่อื่นหลังจากคุณเปิดหน้านี้</span><button class="small" data-act="forceSave">บันทึกทับ</button><button class="small" data-act="reloadRec">โหลดของล่าสุด</button></div>`:""}
    ${draftBanner()}
    <div class="tabs" role="tablist">${TABS.map(([id,t])=>`<button role="tab" aria-selected="${tab===id}" data-act="tab" data-tab="${id}">${t}</button>`).join("")}</div>
    <div class="drawer-body">${body}</div></aside>`;
  const b=$(".drawer-body"); if(b){ b.scrollTop=scrollTop; document.querySelectorAll(".drawer-body details").forEach((d,i)=>{ if(openSet[i]!==undefined) d.open=openSet[i]; }); }
}
let pendingDraft=null;
function draftBanner(){ return pendingDraft?`<div class="banner" style="margin:10px 16px 0"><span>มีฉบับร่างที่ยังไม่ได้บันทึกจากครั้งก่อน</span><button class="small" data-act="loadDraft">โหลดร่าง</button><button class="small" data-act="dropDraft">ทิ้ง</button></div>`:""; }

/* =================== events =================== */
let draftTimer;
function changed(structural){
  dirty=true;
  clearTimeout(draftTimer); draftTimer=setTimeout(()=>{ try{ localStorage.setItem(DRAFT_KEY,JSON.stringify({base:S.updatedAt,data:S})); }catch(e){} },600);
  renderSite();
  if(structural||!adminOpen) renderAdmin(); else renderAdminHeaderOnly();
}
function renderAdminHeaderOnly(){ const btn=document.querySelector('.drawer-head [data-act="save"]'); if(btn){ btn.disabled=!dirty; btn.textContent=dirty?"บันทึก":"บันทึกแล้ว"; } else renderAdmin(); }

document.addEventListener("input",e=>{
  const el=e.target;
  if(el.dataset?.rec){ REC[el.dataset.rec] = el.type==="checkbox"?el.checked:el.value; dirty=true; renderAdminHeaderOnly(); if(el.type==="checkbox") renderAdmin(); return; }
  const p=el.dataset?.bind; if(!p) return;
  let v;
  if("bool" in el.dataset) v=el.checked;
  else if("pct" in el.dataset) v=(parseFloat(el.value)||0)/100;
  else if("num" in el.dataset) v=parseCount(el.value);
  else if("rate" in el.dataset){ const ks=p.split("."); const c=S.channels[+ks[1]]; if(el.value.trim()==="") delete c.rates[ks[3]]; else c.rates[ks[3]]=parseCount(el.value); changed(false); return; }
  else if("override" in el.dataset){ const ks=p.split("."); const c=S.channels[+ks[1]]; if(el.value.trim()==="") delete c.override[ks[3]]; else c.override[ks[3]]=parseCount(el.value); changed(false); return; }
  else v=el.value;
  if(p.includes(".ph.")){ const ks=p.split("."); S.channels[+ks[1]].ph[ks[3]]=v; }
  else setPath(p,v);
  const structural = el.type==="checkbox" || el.tagName==="SELECT";
  changed(structural);
});
document.addEventListener("change",e=>{
  const el=e.target;
  if(el.dataset?.avatar!==undefined && el.files?.[0]) readImage(el.files[0],160,true).then(d=>{ S.channels[+el.dataset.avatar].avatar=d; changed(true); });
  else if(el.dataset?.logo2!==undefined && el.files?.[0]) readImage(el.files[0],480,false).then(d=>{ S.brand.logo2=d; changed(true); });
  else if(el.dataset?.logo!==undefined && el.files?.[0]) readImage(el.files[0],480,false).then(d=>{ S.brand.logo=d; changed(true); });
  else if(el.dataset?.import!==undefined && el.files?.[0]) el.files[0].text().then(t=>loadJSON(t));
  else if(el.dataset?.bind && "num" in el.dataset && el.type!=="checkbox") { /* reformat after edit */ }
});
function readImage(file,size,square){
  return new Promise((res,rej)=>{ const fr=new FileReader(); fr.onload=()=>{ const img=new Image(); img.onload=()=>{
    const cv=document.createElement("canvas"); let w,h,sx=0,sy=0,sw=img.width,sh=img.height;
    if(square){ const s=Math.min(sw,sh); sx=(sw-s)/2; sy=(sh-s)/2; sw=sh=s; w=h=size; } else { const r=Math.min(1,size/Math.max(sw,sh)); w=Math.round(sw*r); h=Math.round(sh*r); }
    cv.width=w; cv.height=h; const cx=cv.getContext("2d"); cx.drawImage(img,sx,sy,sw,sh,0,0,w,h);
    res(square?cv.toDataURL("image/jpeg",.86):cv.toDataURL("image/png")); }; img.onerror=rej; img.src=fr.result; }; fr.onerror=rej; fr.readAsDataURL(file); });
}
function move(arr,i,d){ const j=i+d; if(j<0||j>=arr.length) return; [arr[i],arr[j]]=[arr[j],arr[i]]; }
document.addEventListener("click",e=>{
  if(e.target.closest("[data-stop]")) e.stopPropagation();
  const b=e.target.closest("[data-act]"); if(!b) { if(menuOpen && !e.target.closest(".menu")){ menuOpen=false; renderSite(); } return; }
  const d=b.dataset, i=+d.i, act=d.act;
  const A={
    toggleAdmin(){ adminOpen=!adminOpen; renderAdmin(); renderSite(); },
    tab(){ tab=d.tab; renderAdmin(); $(".drawer-body").scrollTop=0; },
    save(){ saveRemote(false); },
    forceSave(){ saveRemote(true); },
    reloadRec(){ location.reload(); },
    goList(){ if(dirty && !b.dataset.sure){ b.dataset.sure="1"; b.textContent="ยังไม่บันทึก กดอีกครั้งเพื่อออก"; return; } location.href=BASE+"/admin"; },
    copyLink(){ copy(clientURL(REC),"คัดลอกลิงก์ลูกค้าแล้ว"); },
    async newLink(){ if(!b.dataset.sure){ b.dataset.sure="1"; b.textContent="ลิงก์เดิมจะใช้ไม่ได้ กดอีกครั้ง"; return; } const r=await api(`/api/proposals/${REC.id}/new-link`,{method:"POST",body:{}}); if(r.ok){ REC.slug=r.data.meta.slug; REC.updatedAt=r.data.meta.updatedAt; renderAdmin(); toast("สร้างลิงก์ใหม่แล้ว ลิงก์เดิมใช้ไม่ได้แล้ว"); } },
    toggleMenu(){ menuOpen=!menuOpen; renderSite(); },
    pickCh(){ unpick.has(d.id)?unpick.delete(d.id):unpick.add(d.id); renderSite(); },
    pickPh(){ unpickPh.has(d.id)?unpickPh.delete(d.id):unpickPh.add(d.id); renderSite(); },
    pickAll(){ unpick.clear(); unpickPh.clear(); renderSite(); },
    pickNone(){ S.channels.forEach(c=>unpick.add(c.id)); renderSite(); },
    phaseView(){ phaseView=d.ph; renderSite(); },
    copyText(){ copy(replyText(),"คัดลอกข้อความแล้ว วางใน LINE/อีเมลได้เลย"); },
    copyTSV(){ menuOpen=false; renderSite(); copy(rateRows().map(r=>r.join("\t")).join("\n"),"คัดลอกตารางแล้ว เปิด Google Sheets แล้วกดวาง"); },
    xlsx(){ menuOpen=false; renderSite(); dlXLSX(); },
    csv(){ menuOpen=false; renderSite(); const csv=rateRows().map(r=>r.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(",")).join("\n"); save(fileBase()+".csv","﻿"+csv); },
    openQuote(){ openQuote(); },
    closeQuote(){ $("#modalRoot").innerHTML=""; },
    pdf(){ exportPDF(b); },
    addCh(){ const ph={}; S.channels.push({id:uid(),name:"ช่องใหม่",niche:"",avatar:"",price:10000,rush:2000,vat:false,on:true,ph,override:{},rates:{},note:"",platforms:[{p:"TikTok",handle:"@",url:"",followers:0,likes:0}]}); changed(true); setTimeout(()=>{ const ds=document.querySelectorAll(".drawer-body details"); ds[ds.length-1].open=true; ds[ds.length-1].scrollIntoView({block:"start"}); },0); },
    delCh(){ S.channels.splice(i,1); changed(true); },
    dupCh(){ const c=clone(S.channels[i]); c.id=uid(); c.name+=" (สำเนา)"; S.channels.splice(i+1,0,c); changed(true); },
    moveCh(){ move(S.channels,i,+d.d); changed(true); },
    addPf(){ S.channels[i].platforms.push({p:"Instagram",handle:"@",url:"",followers:0,likes:0}); changed(true); },
    delPf(){ S.channels[i].platforms.splice(+d.j,1); changed(true); },
    clearAvatar(){ S.channels[i].avatar=""; changed(true); },
    clearLogo(){ S.brand.logo=""; changed(true); },
    clearLogo2(){ S.brand.logo2=""; changed(true); },
    addPhItem(){ S.phases[+d.p].items.push({id:"i"+uid(),type:S.itemTypes[0]?.id||"",label:"",qty:1,rush:false}); changed(true); },
    delPhItem(){ S.phases[+d.p].items.splice(+d.c,1); changed(true); },
    addType(){ S.itemTypes.push({id:"t"+uid(),label:"รายการใหม่",unit:"ชิ้น",ratio:.5,floor:0,included:false,note:""}); changed(true); },
    delType(){ const id=S.itemTypes[i].id; if(S.phases.some(p=>(p.items||[]).some(it=>it.type===id))){ toast("รายการนี้ยังถูกใช้ใน Phase อยู่ ลบออกจาก Phase ก่อน"); return; } S.itemTypes.splice(i,1); changed(true); },
    addPhase(){ S.phases.push({id:"p"+uid(),name:"Phase ใหม่",dates:"",deliverables:"",items:[{id:"i"+uid(),type:S.itemTypes[0]?.id||"",label:"",qty:1,rush:false}]}); changed(true); },
    delPhase(){ S.phases.splice(+d.p,1); changed(true); },
    movePhase(){ move(S.phases,+d.p,+d.d); changed(true); },
    addTier(){ const l=S.settings.tiers.at(-1)||{min:1,pct:0}; S.settings.tiers.push({min:+l.min+2,pct:+l.pct+3}); changed(true); },
    delTier(){ S.settings.tiers.splice(i,1); changed(true); },
    addExtra(){ S.extras.push({id:"x"+uid(),label:"ค่าใหม่",type:"dealPct",value:10,on:true,jobs:1.5,months:1,likelihood:15,note:""}); changed(true); },
    delExtra(){ S.extras.splice(i,1); changed(true); },
    addItem(){ S.quote.customItems.push({title:"รายการใหม่",desc:"",qty:1,unit:"งาน",price:0}); changed(true); },
    delItem(){ S.quote.customItems.splice(i,1); changed(true); },
    genItems(){ S.quote.customItems=autoItems().map(({_ph,...it})=>it); quoteData().lines.forEach(([title,price])=>{ if(title!==S.settings.manualDiscountLabel) S.quote.customItems.push({title,desc:"",qty:1,unit:"รายการ",price}); }); changed(true); },
    dlJSON(){ save(fileBase()+".json",JSON.stringify(S,null,1)); },
    copyJSON(){ copy(JSON.stringify(S),"คัดลอก JSON แล้ว"); },
    pasteJSON(){ loadJSON($("#jsonBox").value); },
    askReset(){ $("#resetBox").hidden=false; },
    cancelReset(){ $("#resetBox").hidden=true; },
    doReset(){ S=clone(DEFAULT); normalize(); changed(true); toast("คืนค่าเริ่มต้นแล้ว กดบันทึกเพื่อยืนยัน"); },
    loadDraft(){ S=pendingDraft; pendingDraft=null; normalize(); changed(true); },
    dropDraft(){ pendingDraft=null; try{localStorage.removeItem(DRAFT_KEY);}catch(e){} renderAdmin(); },
  };
  if(A[act]){ e.preventDefault(); A[act](); }
});
function loadJSON(t){ try{ const o=JSON.parse(t); if(!o.channels||!o.phases) throw 0; S=o; normalize(); changed(true); toast("โหลดข้อมูลแล้ว กดบันทึกเพื่อใช้บนลิงก์นี้"); }catch(e){ toast("ไฟล์ไม่ถูกต้อง ต้องเป็น JSON ที่ได้จากหน้านี้"); } }

/* =================== server API =================== */
async function api(path,{method="GET",body}={}){
  const r=await fetch(BASE+path,{method,credentials:"same-origin",headers:body?{"Content-Type":"application/json"}:{},body:body?JSON.stringify(body):undefined});
  let data=null; try{ data=await r.json(); }catch(e){}
  return {ok:r.ok,status:r.status,data};
}
function clientURL(rec){ return location.origin+BASE+"/p/"+rec.slug; }
async function saveRemote(force){
  S.updatedAt=new Date().toISOString();
  try{ localStorage.setItem(DRAFT_KEY,JSON.stringify({base:REC.updatedAt,data:S})); }catch(e){}
  const r=await api(`/api/proposals/${REC.id}`,{method:"PUT",body:{title:REC.title,published:!!REC.published,state:S,baseUpdatedAt:force?null:REC.updatedAt}});
  if(r.status===401){ toast("หมดเวลาเข้าสู่ระบบ งานที่แก้เก็บเป็นร่างไว้แล้ว"); setTimeout(()=>location.reload(),1200); return; }
  if(r.status===409){ conflict=true; renderAdmin(); toast("มีการบันทึกจากที่อื่นก่อน เลือกบันทึกทับหรือโหลดของล่าสุด"); return; }
  if(!r.ok){ toast(r.data?.error||"บันทึกไม่สำเร็จ ลองอีกครั้ง"); return; }
  REC=r.data.meta; conflict=false; dirty=false;
  try{ localStorage.removeItem(DRAFT_KEY); }catch(e){}
  renderAdmin(); toast(REC.published?"บันทึกแล้ว ลูกค้าที่เปิดลิงก์จะเห็นเวอร์ชันนี้":"บันทึกแล้ว (ลิงก์ลูกค้ายังปิดอยู่)");
}
function checkDraft(){ try{ const r=JSON.parse(localStorage.getItem(DRAFT_KEY)||"null"); if(r&&r.data&&JSON.stringify(r.data)!==JSON.stringify(S)) pendingDraft=r.data; }catch(e){} }

/* =================== exports =================== */
function fileBase(){ const a=String(S.meta.campaign||"").replace(/[^A-Za-z0-9]+/g,"-").replace(/^-|-$/g,""); return ("proposal-"+(a||"quote")).slice(0,60); } // ASCII only: some browsers drop non-ASCII download names
async function save(filename,data){
  const blob=data instanceof Blob?data:new Blob([data]);
  const a=document.createElement("a"); a.href=URL.createObjectURL(blob); a.download=filename;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(a.href),4000);
}
function copy(txt,msg){
  const fallback=()=>{ const t=document.createElement("textarea"); t.value=txt; t.style.cssText="position:fixed;inset:20% 16px auto;height:50%;z-index:95"; document.body.appendChild(t); t.select(); toast("กด Ctrl/Cmd+C เพื่อคัดลอก แล้วคลิกที่อื่นเพื่อปิด"); t.addEventListener("blur",()=>t.remove()); };
  try{ navigator.clipboard.writeText(txt).then(()=>toast(msg),fallback); }catch(e){ fallback(); }
}
function toast(m){ document.querySelectorAll(".toast").forEach(t=>t.remove()); const t=document.createElement("div"); t.className="toast"; t.setAttribute("role","status"); t.textContent=m; document.body.appendChild(t); setTimeout(()=>t.remove(),3200); }
function replyText(){
  const q=quote(); const L=[`สวัสดีครับ ขอส่งเรทแคมเปญ ${S.meta.campaign} ครับ`,""];
  q.list.forEach(({c,k})=>{
    L.push(`▶ ช่อง ${c.name} — ผู้ติดตามรวม ${compact(reach(c))}`);
    L.push("   "+c.platforms.map(p=>`${p.p} ${compact(p.followers)}`).join(" / "));
    if(c.platforms[0]?.url) L.push("   "+c.platforms[0].url);
    k.act.forEach(r=>{ L.push(`- ${r.ph.name} = ${fmt(r.price)} บาท`); L.push(`   (${linesText(r)})`); });
    if(k.bundle) L.push(`- ส่วนลดรับครบทุก Phase = −${fmt(k.bundle)} บาท`);
    if(k.rush) L.push(`- ค่าเร่งงาน = ${fmt(k.rush)} บาท`);
    k.extras.forEach(e=>L.push(`- ${e.x.label} = ${fmt(e.amt)} บาท`));
    L.push(`รวม = ${fmt(k.total)} บาท`,"");
  });
  L.push(`รวม ${q.sel.length} ช่อง = ${fmt(q.sub)} บาท`);
  if(q.disc) L.push(`ส่วนลดแพ็ก ${q.sel.length} ช่อง ${q.pct}% = −${fmt(q.disc)} บาท`);
  q.deal.forEach(e=>L.push(`${e.x.label}${e.x.type==="dealPct"?` ${e.x.value}%`:""} (คิดครั้งเดียว) = ${fmt(e.amt)} บาท`));
  if(q.manual) L.push(`${S.settings.manualDiscountLabel} = −${fmt(q.manual)} บาท`);
  L.push(`ราคาสุทธิ = ${fmt(q.pre)} บาท (ยังไม่รวม VAT)`,"");
  L.push("สรุปราคาแยก Phase (รวมทุกช่อง ถ้าซื้อเฉพาะ Phase นั้น)");
  S.phases.map(phaseSummary).forEach(x=>L.push(`- ${x.ph.name} (${x.rows.length} ช่อง) = ${fmt(x.pre)} บาท`));
  L.push(`- ครบทุก Phase = ${fmt(q.pre)} บาท`,"","หมายเหตุ");
  S.terms.split("\n").filter(l=>l.trim()).forEach(l=>L.push("• "+l));
  return L.join("\n");
}
function rateRows(){
  const q=quote(); const ex=S.extras.filter(x=>x.on&&!isDeal(x));
  const head=["ช่อง","ผู้ติดตามรวม","TikTok","Instagram","YouTube","Facebook","TikTok Likes","ราคา 1 คลิป",...S.phases.map(p=>p.name),"ส่วนลดครบ Phase","ค่าเร่งงาน",...ex.map(x=>x.label),"รวม/ช่อง","ลิงก์"];
  const pf=(c,n)=>c.platforms.filter(p=>p.p===n).reduce((s,p)=>s+(+p.followers||0),0)||"";
  const rows=q.list.map(({c,k})=>[c.name,reach(c),pf(c,"TikTok"),pf(c,"Instagram"),pf(c,"YouTube"),pf(c,"Facebook"),c.platforms.reduce((s,p)=>s+(+p.likes||0),0)||"",k.P||"",...k.rows.map(r=>r.on?r.price:""),k.bundle?-k.bundle:"",k.rush||"",...ex.map(x=>k.extras.find(e=>e.x.id===x.id)?.amt||""),k.total,c.platforms[0]?.url||""]);
  const pad=n=>Array(n).fill("");
  const w=head.length;
  const foot=[[...pad(w-3),"รวม",q.sub,""]];
  if(q.disc) foot.push([...pad(w-3),`ส่วนลดแพ็ก ${q.pct}%`,-q.disc,""]);
  q.deal.forEach(e=>foot.push([...pad(w-3),`${e.x.label}${e.x.type==="dealPct"?` ${e.x.value}%`:""} (ครั้งเดียว)`,e.amt,""]));
  if(q.manual) foot.push([...pad(w-3),S.settings.manualDiscountLabel,-q.manual,""]);
  foot.push([...pad(w-3),"สุทธิก่อน VAT",q.pre,""]);
  if(S.settings.vatMode!=="none") foot.push([...pad(w-3),`VAT ${S.settings.vatPct}%`,Math.round(q.vat*100)/100,""],[...pad(w-3),"รวมทั้งสิ้น",Math.round(q.grand*100)/100,""]);
  const items=[[],["รายการงานต่อ Phase"],["ช่อง","Phase","รายการ","จำนวน","ราคาต่อหน่วย","รวม"],
    ...q.list.flatMap(({c,k})=>k.act.flatMap(r=>[...r.lines.map(l=>[c.name,r.ph.name,l.label,l.qty,l.included?"รวมแล้ว":l.unit,l.amt]),...(r.rush?[[c.name,r.ph.name,"ค่าเร่งงาน","","",r.rush]]:[])]))];
  const ps=S.phases.map(phaseSummary);
  const phBlock=[[],["สรุปราคาแยก Phase (รวมทุกช่อง ถ้าซื้อเฉพาะ Phase นั้น)"],["Phase","จำนวนช่อง","ค่าคอนเทนต์","ค่าเร่งงาน","ค่าเพิ่ม","ส่วนลดแพ็ก %","ส่วนลดแพ็ก","ค่าครั้งเดียวต่อดีล","สุทธิก่อน VAT","VAT","รวมทั้งสิ้น"],
    ...ps.map(x=>[x.ph.name,x.rows.length,x.content,x.rush,x.extra,x.pct,-x.disc,x.dealAmt,x.pre,Math.round(x.vat*100)/100,Math.round(x.grand*100)/100]),
    ["ครบทุก Phase",q.sel.length,q.net,q.rush,q.extra,q.pct,-q.disc,q.dealAmt,q.pre,Math.round(q.vat*100)/100,Math.round(q.grand*100)/100]];
  return [[S.meta.campaign],[`${S.meta.client} × ${S.meta.brand} · ${S.meta.date}`],[],head,...rows,[],...foot,...phBlock,...items];
}
function dlXLSX(){
  if(!window.XLSX){ toast("โหลดตัวสร้างไฟล์ไม่สำเร็จ ใช้ “คัดลอกตาราง” แทน"); return; }
  const wb=XLSX.utils.book_new();
  const ws=XLSX.utils.aoa_to_sheet(rateRows()); ws["!cols"]=[{wch:18},{wch:12},{wch:10},{wch:10},{wch:10},{wch:10},{wch:12},{wch:11},...S.phases.map(()=>({wch:14})),{wch:12},{wch:14},{wch:14},{wch:12},{wch:36}];
  XLSX.utils.book_append_sheet(wb,ws,"Rate");
  const qd=quoteData();
  const qrows=[[S.company.nameTh],[S.company.nameEn],["ใบเสนอราคา / Quotation", "", "#"+S.quote.number],["วันที่",S.quote.date],["Project",S.quote.project],[],["#","รายการ","รายละเอียด","Qty","หน่วย","Unit price","Total"],...qd.items.map((it,i)=>[i+1,it.title,it.desc,+it.qty,it.unit,+it.price,(+it.qty)*(+it.price)]),[],["","","","","","Subtotal",qd.sub],...qd.lines.map(l=>["","","","","",l[0],l[1]]),["","","","","","Total",qd.total]];
  if(S.settings.vatMode!=="none") qrows.push(["","","","","",`VAT ${S.settings.vatPct}%`,Math.round(qd.vat*100)/100],["","","","","","Grand total",Math.round(qd.grand*100)/100]);
  const ws2=XLSX.utils.aoa_to_sheet(qrows); ws2["!cols"]=[{wch:5},{wch:40},{wch:50},{wch:6},{wch:8},{wch:14},{wch:14}];
  XLSX.utils.book_append_sheet(wb,ws2,"Quotation");
  const buf=XLSX.write(wb,{bookType:"xlsx",type:"array"});
  save(fileBase()+".xlsx",new Blob([buf]));
}
function quoteHTML(){
  const qd=quoteData(), co=S.company, qt=S.quote;
  const vatRow=S.settings.vatMode!=="none";
  return `<div class="qdoc" id="qdoc">
    <div class="qbar"></div>
    <div class="qtop"><div class="co">${S.brand.logo?`<img src="${esc(S.brand.logo)}" alt="" style="height:46px;width:auto;display:block;margin-bottom:10px">`:""}<b>${esc(co.nameTh)}</b><b>${esc(co.nameEn)}</b><div class="addr">${esc(co.address)}</div></div>
      <div class="right"><div>เลขประจำตัวผู้เสียภาษี : ${esc(co.taxId)}</div><div>${esc(co.email)}</div><div>${esc(co.phone)}</div></div></div>
    <h1 class="qt">ใบเสนอราคา /Quotation</h1><div class="qd">วันที่ : ${esc(qt.date)}</div>
    <div class="qmeta"><div><div class="h">Quotation for</div><div class="v">${esc(qt.clientBlock)}</div></div><div><div class="h">Project</div><div class="v proj">${esc(qt.project)}</div></div><div><div class="h">Quotation#</div><div class="v">${esc(qt.number)}</div></div></div>
    <hr>
    <table><thead><tr><th colspan="2">${esc(qt.sectionTitle)}</th><th style="text-align:right">Qty</th><th style="text-align:right">Unit price</th><th style="text-align:right">Total</th></tr></thead>
    <tbody>${qd.items.map((it,i)=>`<tr><td class="n">${i+1}.</td><td><div class="t">${esc(it.title)}</div>${it.desc?`<div class="d">${esc(it.desc)}</div>`:""}</td><td class="qty">${esc(it.qty)} ${esc(it.unit)}</td><td style="text-align:right;white-space:nowrap">${fmt2(it.price)}</td><td style="text-align:right;white-space:nowrap">${fmt2((+it.qty)*(+it.price))}</td></tr>`).join("")}</tbody></table>
    <div class="qfoot"><div class="notes"><h4>หมายเหตุ</h4><div>${esc(qt.notes)}</div></div>
      <div class="tot"><span class="k">Subtotal</span><span>${fmt2(qd.sub)}</span>
        ${qd.lines.map(l=>`<span class="k">${esc(l[0])}</span><span>${fmt2(l[1])}</span>`).join("")}
        <span class="k">Total</span><b>฿${fmt2(qd.total)}</b>
        ${vatRow?`<span class="k">VAT ${S.settings.vatPct}%</span><b>฿${fmt2(qd.vat)}</b><span></span><span class="gv">฿${fmt2(qd.grand)}</span>`:""}</div></div>
    ${qt.showSign?`<div class="sign"><div>ผู้เสนอราคา${qt.signName?`<br>${esc(qt.signName)}`:""}</div><div>ผู้อนุมัติ / ลูกค้า</div></div>`:""}
  </div>`;
}
function openQuote(){
  menuOpen=false; renderSite();
  $("#modalRoot").innerHTML=`<div class="modal" role="dialog" aria-label="ใบเสนอราคา"><div class="modal-bar"><button class="small solid" data-act="pdf">ดาวน์โหลด PDF</button><button class="small" data-act="xlsx">.xlsx</button><button class="small" data-act="closeQuote">ปิด</button></div><div class="qwrap"><div class="qscale">${quoteHTML()}</div></div></div>`;
  fitQuote();
}
function fitQuote(){ const w=$(".qwrap"), s=$(".qscale"); if(!w||!s) return; const k=Math.min(1,w.clientWidth/794); s.style.transform=`scale(${k})`; s.style.height=($("#qdoc").offsetHeight*k)+"px"; w.style.height=($("#qdoc").offsetHeight*k)+"px"; }
addEventListener("resize",fitQuote);
function paginate(doc){
  const PH=1123, M=56;
  const els=[...doc.querySelectorAll("tbody tr, .qfoot, .sign")];
  for(const el of els){
    const d=doc.getBoundingClientRect(), r=el.getBoundingClientRect();
    const top=r.top-d.top, bottom=top+r.height, pageEnd=(Math.floor(top/PH)+1)*PH-M;
    if(bottom>pageEnd && r.height<PH-2*M){
      const push=Math.ceil(pageEnd+M+M-top);
      if(el.tagName==="TR"){ const sp=document.createElement("tr"); sp.innerHTML=`<td colspan="5" style="height:${push}px;padding:0"></td>`; el.before(sp); }
      else el.style.marginTop=(parseFloat(getComputedStyle(el).marginTop)+push)+"px";
    }
  }
  const h=doc.getBoundingClientRect().height; doc.style.minHeight=(Math.ceil(h/PH)*PH)+"px";
}
async function exportPDF(btn){
  if(!window.html2canvas||!window.jspdf){ toast("โหลดตัวสร้าง PDF ไม่สำเร็จ"); return; }
  btn.disabled=true; const old=btn.textContent; btn.textContent="กำลังสร้าง…";
  try{
    const src=$("#qdoc"); const holder=document.createElement("div"); holder.style.cssText="position:fixed;left:-10000px;top:0"; holder.appendChild(src.cloneNode(true)); document.body.appendChild(holder);
    await document.fonts?.ready;
    paginate(holder.firstChild);
    const canvas=await html2canvas(holder.firstChild,{scale:2,backgroundColor:"#ffffff",useCORS:true,windowWidth:794});
    holder.remove();
    const {jsPDF}=window.jspdf; const pdf=new jsPDF({unit:"mm",format:"a4"});
    const pageH=Math.round(canvas.width*297/210);
    for(let y=0,pg=0;y<canvas.height;y+=pageH,pg++){
      const c=document.createElement("canvas"); c.width=canvas.width; c.height=Math.min(pageH,canvas.height-y);
      const cx=c.getContext("2d"); cx.fillStyle="#fff"; cx.fillRect(0,0,c.width,c.height); cx.drawImage(canvas,0,y,c.width,c.height,0,0,c.width,c.height);
      if(pg) pdf.addPage();
      pdf.addImage(c.toDataURL("image/jpeg",.92),"JPEG",0,0,210,c.height*210/c.width);
    }
    await save(`Quotation-${S.quote.number}-${fileBase()}.pdf`,pdf.output("blob"));
  }catch(e){ toast("สร้าง PDF ไม่สำเร็จ"); }
  btn.disabled=false; btn.textContent=old;
}

/* =================== admin: login & list =================== */
function renderLogin(msg){
  document.title="เข้าสู่ระบบ · Proposal Backend";
  $("#app").innerHTML=`<main class="auth gutter"><form id="loginForm" class="auth-card">
    <h1>Proposal Backend</h1><p class="help">สำหรับทีมงานเท่านั้น</p>
    <div class="f"><label for="pw">รหัสผ่าน</label><input id="pw" type="password" autocomplete="current-password" required autofocus></div>
    ${msg?`<p class="err" role="alert">${esc(msg)}</p>`:""}
    <button class="solid" type="submit">เข้าสู่ระบบ</button></form></main>`;
  $("#loginForm").addEventListener("submit",async e=>{
    e.preventDefault();
    const r=await api("/api/login",{method:"POST",body:{password:$("#pw").value}});
    if(r.ok) location.reload(); else renderLogin(r.status===429?"ลองผิดหลายครั้งเกินไป รอ 15 นาทีแล้วลองใหม่":"รหัสผ่านไม่ถูกต้อง");
  });
}
function when(iso){ try{ return new Date(iso).toLocaleString("th-TH",{dateStyle:"medium",timeStyle:"short"}); }catch(e){ return iso||""; } }
async function renderList(){
  document.title="ข้อเสนอทั้งหมด · Proposal Backend";
  const r=await api("/api/proposals"); if(r.status===401) return renderLogin();
  const items=r.data?.items||[];
  $("#app").innerHTML=`<header class="topbar gutter"><div class="max"><span class="wordmark">Proposal Backend</span>
      <div class="actions"><button class="small solid" data-list="new">+ ข้อเสนอใหม่จากเทมเพลต</button><button class="small" data-list="logout">ออกจากระบบ</button></div></div></header>
    <main class="block gutter"><div class="max">
      <div class="block-head"><h2>Proposals</h2><p>ลิงก์ลูกค้าแต่ละอันแยกกัน ลูกค้าเห็นเฉพาะราคาสุดท้าย ไม่เห็นสูตรหรือหน้านี้</p></div>
      <div class="scroll"><table><thead><tr><th>ชื่อ</th><th>ลูกค้า</th><th>สถานะ</th><th>แก้ล่าสุด</th><th></th></tr></thead><tbody>
      ${items.map(it=>`<tr><td><a href="${BASE}/admin/p/${esc(it.id)}"><b>${esc(it.title)}</b></a></td><td>${esc(it.client||"")}</td>
        <td>${it.published?`<span class="pill on">เปิดลิงก์</span>`:`<span class="pill">ปิด</span>`}</td><td class="num">${esc(when(it.updatedAt))}</td>
        <td class="r" style="white-space:nowrap"><a class="small btnlink" href="${BASE}/admin/p/${esc(it.id)}">แก้ไข</a>
          <button class="small" data-list="copy" data-slug="${esc(it.slug)}">ลิงก์ลูกค้า</button>
          <button class="small" data-list="dup" data-id="${esc(it.id)}">ทำสำเนา</button>
          <button class="small danger" data-list="del" data-id="${esc(it.id)}">ลบ</button></td></tr>`).join("")||`<tr><td colspan="5">ยังไม่มีข้อเสนอ</td></tr>`}
      </tbody></table></div></div></main>`;
}
async function listAction(b){
  const a=b.dataset.list;
  if(a==="logout"){ await api("/api/logout",{method:"POST"}); location.reload(); }
  else if(a==="new"){ const r=await api("/api/proposals",{method:"POST",body:{}}); if(r.ok) location.href=`${BASE}/admin/p/${r.data.meta.id}`; }
  else if(a==="dup"){ const r=await api("/api/proposals",{method:"POST",body:{fromId:b.dataset.id}}); if(r.ok) location.href=`${BASE}/admin/p/${r.data.meta.id}`; }
  else if(a==="copy"){ copy(location.origin+BASE+"/p/"+b.dataset.slug,"คัดลอกลิงก์ลูกค้าแล้ว"); }
  else if(a==="del"){ if(!b.dataset.sure){ b.dataset.sure="1"; b.textContent="กดอีกครั้งเพื่อลบ"; return; } await api(`/api/proposals/${b.dataset.id}`,{method:"DELETE"}); renderList(); }
}
document.addEventListener("click",e=>{ const b=e.target.closest("[data-list]"); if(b){ e.preventDefault(); listAction(b); } });

/* =================== boot =================== */
async function boot(){
  if(MODE==="client"){
    const slug=decodeURIComponent(location.pathname.split("/p/")[1]||"").replace(/\/.*$/,"");
    const r=await api(`/api/public/${encodeURIComponent(slug)}`);
    if(!r.ok){ $("#app").innerHTML=`<main class="auth gutter"><div class="auth-card"><h1>ไม่พบข้อเสนอ</h1><p class="help">ลิงก์นี้อาจหมดอายุหรือถูกปิดไว้ กรุณาติดต่อทีมงาน</p></div></main>`; return; }
    S=r.data; DEFAULT=clone(S); normalize();
    document.title=`${S.meta.campaign} · ${S.brand.name}`;
    renderSite(); return;
  }
  // admin
  const me=await api("/api/me");
  if(!me.data?.authenticated) return renderLogin();
  const m=location.pathname.match(/\/admin\/p\/([a-f0-9]+)/);
  if(!m) return renderList();
  const [rec,seed]=await Promise.all([api(`/api/proposals/${m[1]}`),api("/api/seed")]);
  if(!rec.ok){ $("#app").innerHTML=`<main class="auth gutter"><div class="auth-card"><h1>ไม่พบข้อเสนอนี้</h1><a href="${BASE}/admin">กลับไปหน้ารายการ</a></div></main>`; return; }
  REC=rec.data.meta; S=rec.data.state; DEFAULT=seed.data; normalize();
  DRAFT_KEY="ssn-draft-"+REC.id;
  caps.canEdit=true; adminOpen=true;
  document.title=`${REC.title} · Backend`;
  checkDraft(); renderSite(); renderAdmin();
  addEventListener("beforeunload",e=>{ if(dirty){ e.preventDefault(); e.returnValue=""; } });
}
boot();
