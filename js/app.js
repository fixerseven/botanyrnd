/* ============================================================
   BOTANY R&D LAB — session/shot logger, offline-first, Sheets sync
   ============================================================ */
"use strict";

const LS_KEY = "botany-lab-v1";
// Shared sync endpoint (Apps Script "Botany Lab Sync" → Botany R&D — Shot Log sheet)
const DEFAULT_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbzxgJjTni9Pdk_3lREr5Kiz73-1LOxgSu9DzTe03PZB3bPMOPKys9HwQ1LevqqnpXLD/exec";

/* ---------- state ---------- */
const defaults = () => ({
  machines: [], grinders: [], beans: [],
  sessions: [], shots: [],
  queue: [],                       // shot ids not yet synced
  settings: { scriptUrl: DEFAULT_SCRIPT_URL, barista: "" },
  activeSessionId: null,
  lastShotPull: 0,
});

let S = load();
function load(){
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw){
      const s = Object.assign(defaults(), JSON.parse(raw));
      if (!s.settings.scriptUrl) s.settings.scriptUrl = DEFAULT_SCRIPT_URL;
      return s;
    }
  }
  catch(e){ console.warn("load failed", e); }
  return defaults();
}
function save(){ localStorage.setItem(LS_KEY, JSON.stringify(S)); }
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const byId = (arr, id) => arr.find(x => x.id === id);
const $ = sel => document.querySelector(sel);
const $$ = sel => [...document.querySelectorAll(sel)];

/* ---------- helpers ---------- */
function fmt(n, dp = 1){ return (Math.round(n * 10 ** dp) / 10 ** dp).toString(); }
function daysOff(roastDate){
  if (!roastDate) return null;
  const d = Math.floor((Date.now() - new Date(roastDate + "T00:00:00")) / 86400000);
  return isNaN(d) ? null : d;
}
function toast(msg){
  const t = $("#toast"); t.textContent = msg; t.classList.add("show");
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("show"), 1900);
}
function activeSession(){ return byId(S.sessions, S.activeSessionId) || null; }
function sessionShots(sid){
  return S.shots.filter(s => s.sessionId === sid).sort((a, b) => new Date(a.ts) - new Date(b.ts));
}
function lastShotIn(sid){ const arr = sessionShots(sid); return arr[arr.length - 1] || null; }
function starredFor(beanId){
  return [...S.shots].reverse().find(s => s.starred && byId(S.sessions, s.sessionId)?.beanId === beanId) || null;
}

/* ---------- brew modes ---------- */
const MODES = {
  espresso: {
    name: "Espresso", dial: true, infusion: false,
    dose: ["Dose", "g in"], yield: ["Yield", "g out"],
    chips: { sour: ["Sour", "under"], balanced: ["Balanced", "sweet spot"], bitter: ["Bitter", "over"] },
    hints: { sour: "Under-extracted — try a finer grind.", bitter: "Over-extracted — try a coarser grind.", balanced: "Lovely. Star it in History." },
    sheet: { sour: "sour", balanced: "balanced", bitter: "bitter" },
    defaults: { dose: 18, yield: 36 },
  },
  teapresso: {
    name: "Teapresso", dial: true, infusion: false,
    dose: ["Leaf", "g in"], yield: ["Yield", "g out"],
    chips: { sour: ["Weak", "thin"], balanced: ["Balanced", "sweet spot"], bitter: ["Tannic", "over"] },
    hints: { sour: "Thin — try finer, hotter, or longer.", bitter: "Tannic — try coarser, cooler, or shorter.", balanced: "Lovely. Star it in History." },
    sheet: { sour: "weak", balanced: "balanced", bitter: "tannic" },
    defaults: { dose: 8, yield: 40 },
  },
  tea: {
    name: "Tea", dial: false, infusion: true,
    dose: ["Leaf", "g"], yield: ["Water", "ml"],
    chips: { sour: ["Weak", "thin"], balanced: ["Balanced", "sweet spot"], bitter: ["Tannic", "bitter"] },
    hints: { sour: "Weak — steep longer or hotter.", bitter: "Astringent — steep shorter or cooler.", balanced: "Lovely. Star it in History." },
    sheet: { sour: "weak", balanced: "balanced", bitter: "tannic" },
    defaults: { dose: 5, yield: 200 },
  },
};
const sessionMode = ses => MODES[(ses && ses.mode) || "espresso"] ? ((ses && ses.mode) || "espresso") : "espresso";
function activeMode(){ return MODES[sessionMode(activeSession())]; }
function verdictText(shot){
  const ses = byId(S.sessions, shot.sessionId);
  return MODES[sessionMode(ses)].sheet[shot.verdict] || shot.verdict;
}

/* ---------- draft (current shot being composed) ---------- */
let draft = { grind: 5.0, dose: 18.0, yield: 36.0, time: null, verdict: null, rating: 0, notes: "", infusion: 1 };
let lastLoggedGrind = null;   // for the delta pill

function grinderStep(){
  const ses = activeSession(); if (!ses) return 1;
  const g = byId(S.grinders, ses.grinderId);
  return (g && parseFloat(g.step)) || 1;
}
function grinderMax(){
  const ses = activeSession(); if (!ses) return 90;
  const g = byId(S.grinders, ses.grinderId);
  return (g && parseFloat(g.max)) || 90;
}
function stepDecimals(){ const s = String(grinderStep()); return s.includes(".") ? s.split(".")[1].length : 0; }

/* ---------- rotary dial ---------- */
let dialBuiltFor = "";
function buildDialSvg(){
  const max = grinderMax();
  const key = `m${max}`;
  if (dialBuiltFor === key) return;
  dialBuiltFor = key;
  const svg = $("#dial-ring");
  const labelEvery = max <= 20 ? 2 : max <= 50 ? 5 : 10;
  const minorEvery = max <= 20 ? 0.5 : 1;
  const parts = [
    // knurled outer edge
    `<circle cx="150" cy="150" r="146" fill="none" stroke="#2A4433" stroke-width="7" stroke-dasharray="2.6 3.6"/>`,
    `<circle cx="150" cy="150" r="139" fill="#152820" stroke="#2A4433" stroke-width="1"/>`,
  ];
  for (let v = 0; v < max; v += minorEvery){
    const major = Math.abs(v % labelEvery) < 1e-9;
    const ang = (v / max) * 360;
    const a = (ang - 90) * Math.PI / 180;
    const r1 = major ? 121 : 129, r2 = 136;
    const x1 = 150 + r1 * Math.cos(a), y1 = 150 + r1 * Math.sin(a);
    const x2 = 150 + r2 * Math.cos(a), y2 = 150 + r2 * Math.sin(a);
    parts.push(`<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${major ? "#C9A96A" : "#3A5443"}" stroke-width="${major ? 2.4 : 1.1}"/>`);
    if (major){
      const rt = 104;
      const xt = 150 + rt * Math.cos(a), yt = 150 + rt * Math.sin(a);
      parts.push(`<text x="${xt.toFixed(1)}" y="${yt.toFixed(1)}" fill="#DCD6C4" font-size="14" font-family="Spline Sans Mono, monospace" font-weight="500" text-anchor="middle" dominant-baseline="middle" transform="rotate(${ang.toFixed(1)} ${xt.toFixed(1)} ${yt.toFixed(1)})">${v}</text>`);
    }
  }
  svg.innerHTML = parts.join("");
}
function setGrind(v, opts = {}){
  const max = grinderMax(), step = grinderStep();
  v = Math.min(max, Math.max(0, v));
  if (!opts.raw) v = Math.round(v / step) * step;
  draft.grind = +v.toFixed(4);
  $("#in-grind").value = fmt(draft.grind, stepDecimals());
  $("#dial-ring").style.transform = `rotate(${(-draft.grind / max * 360).toFixed(3)}deg)`;
  renderDelta();
}
function bindDial(){
  const wrap = $("#dial-wrap");
  const square = $("#dial-square");
  let prev = null, sweep = 0, grabValue = 0;
  const angleAt = e => {
    const r = square.getBoundingClientRect();
    return Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2)) * 180 / Math.PI;
  };
  wrap.addEventListener("pointerdown", e => {
    if (e.target.id === "in-grind") return;
    e.preventDefault();
    try { wrap.setPointerCapture(e.pointerId); } catch(_){}
    prev = angleAt(e); sweep = 0; grabValue = draft.grind;
  });
  wrap.addEventListener("pointermove", e => {
    if (prev == null) return;
    let a = angleAt(e), da = a - prev;
    if (da > 180) da -= 360; if (da < -180) da += 360;   // continuous across the ±180° seam
    prev = a; sweep += da;
    // clockwise sweep = coarser (value up); value locked to total sweep from grab point
    const before = draft.grind;
    setGrind(grabValue + sweep / 360 * grinderMax());
    if (draft.grind !== before && navigator.vibrate) navigator.vibrate(5);
  });
  ["pointerup", "pointercancel"].forEach(ev =>
    wrap.addEventListener(ev, () => { prev = null; }));
}

function prefillDraft(){
  const ses = activeSession(); if (!ses) return;
  const last = lastShotIn(ses.id);
  const star = starredFor(ses.beanId);
  const M = activeMode();
  const src = last || star;
  if (src){
    draft.grind = src.grind; draft.dose = src.dose; draft.yield = src.yield;
  } else {
    // last shot ever on this grinder, else mode defaults
    const prior = [...S.shots].reverse().find(s => byId(S.sessions, s.sessionId)?.grinderId === ses.grinderId);
    draft.grind = prior ? prior.grind : Math.round(grinderMax() / 3);
    draft.dose = M.defaults.dose;
    draft.yield = M.defaults.yield;
  }
  draft.infusion = M.infusion ? (last ? (last.infusion || 1) + 1 : 1) : 1;
  lastLoggedGrind = last ? last.grind : (star ? star.grind : null);
  draft.time = null; draft.verdict = null; draft.rating = 0; draft.notes = "";
}

/* ---------- render: dial view ---------- */
function renderDial(){
  const ses = activeSession();
  $("#session-empty").classList.toggle("hidden", !!ses);
  $("#session-active").classList.toggle("hidden", !ses);
  if (!ses) return;

  const bean = byId(S.beans, ses.beanId), gr = byId(S.grinders, ses.grinderId), ma = byId(S.machines, ses.machineId);
  $("#sb-bean").textContent = bean ? bean.name : "—";
  const d = bean ? daysOff(bean.roastDate) : null;
  $("#sb-roast").textContent = d != null ? `${d}d off roast` : "";
  $("#sb-gear").textContent = [gr?.name, ma?.name, ses.waterTemp ? ses.waterTemp + "°C" : null, ses.pressure ? ses.pressure + " bar" : null].filter(Boolean).join("  ·  ");
  const n = sessionShots(ses.id).length;
  $("#sb-count").textContent = `${n} shot${n === 1 ? "" : "s"}`;

  const M = activeMode();
  $("#grind-card").classList.toggle("hidden", !M.dial);
  $("#infusion-card").classList.toggle("hidden", !M.infusion);
  $("#dose-label").innerHTML = `${M.dose[0]} <span class="unit">${M.dose[1]}</span>`;
  $("#yield-label").innerHTML = `${M.yield[0]} <span class="unit">${M.yield[1]}</span>`;
  Object.entries(M.chips).forEach(([code, [label, sub]]) => {
    const chip = $(`#verdict-chips .chip[data-v="${code}"]`);
    if (chip) chip.innerHTML = `${label}<small>${sub}</small>`;
  });

  const gu = gr?.unit ? gr.unit : "";
  $("#grind-unit").textContent = `0–${grinderMax()}${gu ? " · " + gu : ""}`;

  if (M.dial){ buildDialSvg(); setGrind(draft.grind); }
  if (M.infusion) $("#in-infusion").value = draft.infusion || 1;
  $("#in-dose").value = fmt(draft.dose);
  $("#in-yield").value = fmt(draft.yield);
  $("#in-time").value = draft.time == null ? "" : fmt(draft.time);
  sizeTimeInput();
  $("#in-notes").value = draft.notes;
  renderDelta(); renderRatio(); renderVerdict(); renderRating();
}
function renderDelta(){
  const el = $("#grind-delta");
  if (lastLoggedGrind == null){ el.textContent = "first shot"; return; }
  const diff = draft.grind - lastLoggedGrind;
  const dp = stepDecimals();
  if (Math.abs(diff) < 10 ** -(dp + 2)) el.textContent = `same as last (${fmt(lastLoggedGrind, dp)})`;
  else el.textContent = `${fmt(lastLoggedGrind, dp)} → ${fmt(draft.grind, dp)}  (${diff > 0 ? "+" : ""}${fmt(diff, dp)})`;
}
function renderRatio(){
  const r = draft.dose > 0 ? draft.yield / draft.dose : 0;
  $("#ratio-out").textContent = `1 : ${fmt(r, 1)}`;
}
function renderVerdict(){
  $$("#verdict-chips .chip").forEach(c => c.classList.toggle("on", c.dataset.v === draft.verdict));
  $("#verdict-hint").textContent = draft.verdict ? activeMode().hints[draft.verdict] : "";
}
function renderRating(){
  $$("#rating button").forEach(b => b.classList.toggle("on", +b.dataset.r <= draft.rating));
}

/* ---------- steppers (tap + press-and-hold) ---------- */
const activeRepeats = new Set();
function stopAllRepeats(){ activeRepeats.forEach(stop => stop()); }
window.addEventListener("pointerup", stopAllRepeats, true);
window.addEventListener("blur", stopAllRepeats);
document.addEventListener("visibilitychange", stopAllRepeats);

function bindHoldButton(sel, fn){
  const btn = $(sel);
  let holdT = null, repT = null;
  const stop = () => { clearTimeout(holdT); clearInterval(repT); holdT = repT = null; activeRepeats.delete(stop); };
  const fire = () => { fn(); if (navigator.vibrate) navigator.vibrate(8); };
  btn.addEventListener("pointerdown", e => {
    e.preventDefault();
    try { btn.setPointerCapture(e.pointerId); } catch(_){}
    fire();
    holdT = setTimeout(() => { repT = setInterval(fire, 110); }, 450);
    activeRepeats.add(stop);
  });
  ["pointerup", "pointerleave", "pointercancel", "lostpointercapture"].forEach(ev =>
    btn.addEventListener(ev, stop));
}

function bindStepper(minusId, plusId, inputId, key, stepFn, min){
  const input = $(inputId);
  const apply = delta => {
    const step = stepFn();
    const val = Math.max(min, (parseFloat(input.value) || 0) + delta * step);
    draft[key] = +val.toFixed(4);
    input.value = fmt(draft[key], key === "grind" ? stepDecimals() : 1);
    if (key === "grind") renderDelta();
    if (key === "dose" || key === "yield") renderRatio();
  };
  [[minusId, -1], [plusId, 1]].forEach(([id, dir]) => bindHoldButton(id, () => apply(dir)));
  input.addEventListener("change", () => {
    const v = parseFloat(input.value.replace(",", "."));
    if (!isNaN(v)) draft[key] = v;
    input.value = fmt(draft[key], key === "grind" ? stepDecimals() : 1);
    if (key === "grind") renderDelta();
    renderRatio();
  });
}

/* ---------- timer ---------- */
let timer = { running: false, startTs: 0, raf: 0 };
function sizeTimeInput(){
  const el = $("#in-time");
  el.style.width = Math.max(3.4, (el.value.length || 3) + 0.6) + "ch";
}
function timerTick(){
  if (!timer.running) return;
  $("#in-time").value = fmt((performance.now() - timer.startTs) / 1000, 1);
  sizeTimeInput();
  timer.raf = requestAnimationFrame(timerTick);
}
function toggleTimer(){
  const btn = $("#btn-timer");
  if (!timer.running){
    timer.running = true; timer.startTs = performance.now();
    btn.classList.add("running"); $("#timer-btn-label").textContent = "Stop";
    timerTick();
  } else {
    timer.running = false; cancelAnimationFrame(timer.raf);
    draft.time = +(((performance.now() - timer.startTs) / 1000).toFixed(1));
    $("#in-time").value = fmt(draft.time, 1);
    btn.classList.remove("running"); $("#timer-btn-label").textContent = "Start";
    if (navigator.vibrate) navigator.vibrate([15, 40, 15]);
  }
}

/* ---------- log shot ---------- */
function logShot(){
  const ses = activeSession(); if (!ses) return;
  const t = parseFloat($("#in-time").value.replace(",", "."));
  draft.time = isNaN(t) ? null : t;
  draft.notes = $("#in-notes").value.trim();
  const M = activeMode();
  const shot = {
    id: uid(), sessionId: ses.id, ts: new Date().toISOString(),
    grind: M.dial ? draft.grind : null, dose: draft.dose, yield: draft.yield,
    time: draft.time, ratio: draft.dose > 0 ? +(draft.yield / draft.dose).toFixed(2) : null,
    infusion: M.infusion ? (draft.infusion || 1) : null,
    verdict: draft.verdict, rating: draft.rating, notes: draft.notes, starred: false,
  };
  S.shots.push(shot);
  S.queue.push(shot.id);
  save();
  const n = sessionShots(ses.id).length;
  toast(`Shot ${n} logged — ${M.dial ? fmt(shot.grind, stepDecimals()) : "steep " + (shot.infusion || 1)} · ${shot.time != null ? fmt(shot.time) + "s" : "no time"}`);
  lastLoggedGrind = shot.grind;
  if (M.infusion) draft.infusion = (shot.infusion || 1) + 1;
  draft.time = null; draft.verdict = null; draft.rating = 0; draft.notes = "";
  renderDial(); renderSyncChip();
  flushQueue();
}

/* ============================================================
   SHEETS SYNC — Apps Script webhook, offline queue
   ============================================================ */
function shotRow(shot){
  const ses = byId(S.sessions, shot.sessionId) || {};
  const bean = byId(S.beans, ses.beanId) || {};
  const mode = sessionMode(ses);
  const dt = new Date(shot.ts);
  return [
    shot.ts, dt.toLocaleDateString(), dt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    S.settings.barista || "", mode,
    (byId(S.machines, ses.machineId) || {}).name || "",
    (byId(S.grinders, ses.grinderId) || {}).name || "",
    bean.name || "", bean.roaster || "", bean.roastDate || "",
    bean.roastDate ? daysOff(bean.roastDate) : "",
    ses.waterTemp ?? "", ses.pressure ?? "",
    shot.grind ?? "", shot.dose, shot.yield, shot.ratio ?? "", shot.time ?? "",
    shot.infusion ?? "",
    shot.verdict ? (MODES[mode].sheet[shot.verdict] || shot.verdict) : "", shot.rating || "", shot.notes || "",
    ses.id || "", shot.id,
  ];
}

/* ---------- shot pull-sync: everyone's shots into History ---------- */
const num = v => { const n = parseFloat(v); return isNaN(n) ? null : n; };
let shotsPulling = false;
async function shotsPull(){
  const url = S.settings.scriptUrl;
  if (!url || !navigator.onLine || shotsPulling) return;
  shotsPulling = true;
  try {
    const since = Math.max(0, (S.lastShotPull || 0) - 86400000); // day of overlap; shot_id de-dupes
    const res = await fetch(url, { method: "POST", body: JSON.stringify({ token: "botany", action: "shots_pull", since }) });
    const j = await res.json();
    if (j && j.ok && Array.isArray(j.rows)){
      let changed = false, maxTs = S.lastShotPull || 0;
      j.rows.forEach(r => {
        const t = new Date(r[0]).getTime() || 0;
        if (t > maxTs) maxTs = t;
        const shotId = String(r[23] || "");
        if (!shotId || byId(S.shots, shotId)) return;         // own or already-pulled shot
        const sid = String(r[22] || "remote-" + shotId);
        if (!byId(S.sessions, sid)){
          S.sessions.push({
            id: sid, ts: String(r[0]), remote: true, mode: String(r[4] || "espresso"),
            machineName: String(r[5] || ""), grinderName: String(r[6] || ""),
            beanName: String(r[7] || ""), roaster: String(r[8] || ""), roastDate: String(r[9] || ""),
            barista: String(r[3] || ""), waterTemp: num(r[11]), pressure: num(r[12]),
          });
        }
        S.shots.push({
          id: shotId, sessionId: sid, ts: String(r[0]), remote: true,
          grind: num(r[13]), dose: num(r[14]), yield: num(r[15]),
          ratio: num(r[16]), time: num(r[17]), infusion: num(r[18]),
          verdict: String(r[19] || "") || null, rating: num(r[20]) || 0,
          notes: String(r[21] || ""), starred: false,
        });
        changed = true;
      });
      if (maxTs > (S.lastShotPull || 0)){ S.lastShotPull = maxTs; changed = true; }
      if (changed){
        save();
        if ($("#view-history").classList.contains("active")) renderHistory();
      }
    }
  } catch(e){ console.warn("shots pull failed", e); }
  shotsPulling = false;
}

let flushing = false;
async function flushQueue(){
  const url = S.settings.scriptUrl;
  if (!url || flushing || !S.queue.length || !navigator.onLine){ renderSyncChip(); return; }
  flushing = true; renderSyncChip("sending");
  try {
    const ids = S.queue.slice(0, 25);
    const rows = ids.map(id => byId(S.shots, id)).filter(Boolean).map(shotRow);
    const res = await fetch(url, { method: "POST", body: JSON.stringify({ token: "botany", rows }) });
    const j = await res.json();
    if (j && j.ok){
      S.queue = S.queue.filter(id => !ids.includes(id));
      save();
      if (S.queue.length){ flushing = false; renderSyncChip(); return flushQueue(); }
    } else throw new Error(j && j.error || "bad response");
  } catch(e){
    console.warn("sync failed", e);
    renderSyncChip("err");
    flushing = false;
    return;
  }
  flushing = false; renderSyncChip();
}
function renderSyncChip(mode){
  const chip = $("#sync-chip"), label = $("#sync-label");
  chip.className = "sync-chip";
  if (!S.settings.scriptUrl){ label.textContent = "local"; }
  else if (mode === "err"){ chip.classList.add("err"); label.textContent = "retry soon"; }
  else if (mode === "sending"){ chip.classList.add("pending"); label.textContent = "syncing…"; }
  else if (S.queue.length){ chip.classList.add("pending"); label.textContent = `${S.queue.length} pending`; }
  else { chip.classList.add("ok"); label.textContent = "synced"; }
  const st = $("#sync-status");
  if (st){
    st.textContent = !S.settings.scriptUrl
      ? "No sync URL yet — shots are stored on this phone. See SETUP.md to connect your Google Sheet."
      : S.queue.length ? `${S.queue.length} shot(s) waiting to sync.` : "All shots synced to the Google Sheet.";
  }
  const rb = $("#btn-default-url");
  if (rb) rb.classList.toggle("hidden", S.settings.scriptUrl === DEFAULT_SCRIPT_URL);
}
async function testSync(){
  const url = $("#set-url").value.trim();
  if (!url) return toast("Paste your Apps Script URL first");
  try {
    const res = await fetch(url, { method: "POST", body: JSON.stringify({ token: "botany", ping: true }) });
    const j = await res.json();
    toast(j && j.ok ? "Connected to sheet ✓" : "Endpoint responded, but not OK");
  } catch(e){ toast("Couldn't reach the endpoint"); }
}

/* ---------- CSV export ---------- */
function exportCsv(){
  const head = ["timestamp","date","time","barista","mode","machine","grinder","bean","roaster","roast_date","days_off_roast","water_temp_c","pressure_bar","grind","dose_g","yield_g","ratio","time_s","infusion","verdict","rating","notes","session_id","shot_id"];
  const esc = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const csv = [head.join(","), ...S.shots.filter(s => !s.remote).map(s => shotRow(s).map(esc).join(","))].join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = `botany-shots-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click(); URL.revokeObjectURL(a.href);
}

/* ============================================================
   SHARED LIBRARY SYNC (Phase 4) — push+pull merge via lib_sync
   ============================================================ */
const KIND_COLL = { bean: "beans", grinder: "grinders", machine: "machines" };
let libSyncing = false;
async function libSync(){
  const url = S.settings.scriptUrl;
  if (!url || !navigator.onLine || libSyncing) return;
  libSyncing = true;
  try {
    const items = [];
    Object.entries(KIND_COLL).forEach(([kind, coll]) =>
      S[coll].forEach(x => items.push(Object.assign({}, x, { _kind: kind, _updated: x.updatedAt || 0 }))));
    const res = await fetch(url, { method: "POST", body: JSON.stringify({ token: "botany", action: "lib_sync", items }) });
    const j = await res.json();
    if (j && j.ok && Array.isArray(j.items)) libMerge(j.items);
  } catch(e){ console.warn("library sync failed", e); }
  libSyncing = false;
}
function libMerge(items){
  let changed = false;
  items.forEach(it => {
    const coll = S[KIND_COLL[it._kind]];
    if (!coll || !it.id) return;
    const upd = Number(it._updated) || 0;
    const data = Object.assign({}, it); delete data._kind; delete data._updated;
    const local = byId(coll, it.id);
    if (!local){ data.updatedAt = upd; coll.push(data); changed = true; }
    else if (upd > (local.updatedAt || 0)){ Object.assign(local, data, { updatedAt: upd }); changed = true; }
  });
  const deduped = dedupeLibrary();
  if (changed || deduped){
    save();
    if ($("#view-library").classList.contains("active")) renderLibrary();
    renderDial();
  }
  if (deduped) setTimeout(libSync, 1500);   // push the dedupe verdicts back to the shop
}
const alive = coll => coll.filter(x => !x.deleted);
const normName = s => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");

/* Same-named items created independently on different phones converge to one:
   earliest id wins (deterministic on every device), missing fields fold into the
   winner, losers are soft-deleted, and this phone's sessions are remapped. */
function dedupeLibrary(){
  let changed = false;
  const refKeys = { beans: "beanId", grinders: "grinderId", machines: "machineId" };
  Object.entries(refKeys).forEach(([coll, refKey]) => {
    const groups = {};
    alive(S[coll]).forEach(x => { const k = normName(x.name); (groups[k] = groups[k] || []).push(x); });
    Object.values(groups).forEach(g => {
      if (g.length < 2) return;
      g.sort((a, b) => a.id < b.id ? -1 : 1);
      const win = g[0];
      g.slice(1).forEach(loser => {
        Object.keys(loser).forEach(k => {
          if (k === "id" || k === "updatedAt" || k === "deleted") return;
          if (loser[k] && !win[k]){ win[k] = loser[k]; win.updatedAt = Date.now(); }
        });
        loser.deleted = true; loser.updatedAt = Date.now();
        S.sessions.forEach(s => { if (s[refKey] === loser.id) s[refKey] = win.id; });
        changed = true;
      });
    });
  });
  return changed;
}

/* ============================================================
   HISTORY
   ============================================================ */
/* --- session dial-in chart (Phase 3): two single-series panels,
       shared x = shot number; no dual axis --- */
function sessionChartHtml(shotsAsc, mode){
  const n = shotsAsc.length;
  if (n < 3) return "";
  const W = 320, padL = 12, padR = 40, panelH = 64, gap = 26, padT = 16;
  const H = padT + panelH * 2 + gap + 16;
  const plotW = W - padL - padR;
  const x = i => padL + i * plotW / (n - 1);
  const panels = mode === "tea"
    ? [
        { key: "time",   color: "#E7CD93", label: "STEEP · S", fmt: v => fmt(v, 1) },
        { key: "rating", color: "#7FB08A", label: "RATING",    fmt: v => fmt(v, 0) },
      ]
    : [
        { key: "grind", color: "#E7CD93", label: "GRIND",    fmt: v => fmt(v, stepDecimals()) },
        { key: "time",  color: "#7FB08A", label: "TIME · S", fmt: v => fmt(v, 1) },
      ];
  const out = [];
  panels.forEach((p, pi) => {
    const top = padT + pi * (panelH + gap);
    const nums = shotsAsc.map(s => s[p.key]).filter(v => v != null && !isNaN(v));
    if (!nums.length) return;
    let mn = Math.min(...nums), mx = Math.max(...nums);
    if (mx - mn < 1e-9){ mn -= 1; mx += 1; }
    const span = mx - mn; mn -= span * 0.18; mx += span * 0.18;
    const y = v => top + panelH - ((v - mn) / (mx - mn)) * panelH;
    out.push(`<text x="${padL}" y="${top - 6}" class="ch-lab">${p.label}</text>`);
    out.push(`<line x1="${padL}" y1="${(top + panelH + 0.5).toFixed(1)}" x2="${W - padR}" y2="${(top + panelH + 0.5).toFixed(1)}" stroke="#2A4433" stroke-width="1"/>`);
    const pts = shotsAsc.map((s, i) => s[p.key] != null && !isNaN(s[p.key]) ? `${x(i).toFixed(1)},${y(s[p.key]).toFixed(1)}` : null).filter(Boolean);
    if (pts.length > 1) out.push(`<polyline points="${pts.join(" ")}" fill="none" stroke="${p.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`);
    let lastPt = null;
    shotsAsc.forEach((s, i) => {
      const v = s[p.key];
      if (v == null || isNaN(v)) return;
      const cx = x(i).toFixed(1), cy = y(v).toFixed(1);
      if (s.starred) out.push(`<circle cx="${cx}" cy="${cy}" r="8" fill="none" stroke="#E7CD93" stroke-width="1.2" opacity=".9"/>`);
      out.push(`<circle cx="${cx}" cy="${cy}" r="4" fill="${p.color}" stroke="#16291F" stroke-width="2"/>`);
      out.push(`<circle cx="${cx}" cy="${cy}" r="13" fill="transparent" class="ch-hit" data-shot="${s.id}"/>`);
      lastPt = [x(i), y(v), v];
    });
    if (lastPt) out.push(`<text x="${(lastPt[0] + 9).toFixed(1)}" y="${(lastPt[1] + 3.5).toFixed(1)}" class="ch-val" fill="${p.color}">${p.fmt(lastPt[2])}</text>`);
  });
  out.push(`<text x="${padL}" y="${H - 3}" class="ch-lab" opacity=".7">SHOT 1</text>`);
  out.push(`<text x="${W - padR}" y="${H - 3}" class="ch-lab" opacity=".7" text-anchor="middle">${n}</text>`);
  const def = shotsAsc.filter(s => s.starred).pop() || shotsAsc[n - 1];
  return `<div class="chart-card">
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Dial-in progression: grind and extraction time per shot">${out.join("")}</svg>
    <div class="ch-readout">${chReadout(def, shotsAsc)}</div>
  </div>`;
}
function displayVerdict(shot){ return shot.remote ? shot.verdict : (shot.verdict ? verdictText(shot) : null); }
function vClass(word){
  if (word === "sour" || word === "weak") return "sour";
  if (word === "bitter" || word === "tannic") return "bitter";
  return "balanced";
}
function chReadout(s, shotsAsc){
  const idx = shotsAsc.indexOf(s) + 1;
  const lead = s.grind != null ? `grind ${fmt(s.grind, stepDecimals())}` : `steep ${s.infusion || 1}`;
  const v = displayVerdict(s);
  return `Shot ${idx} · ${lead} · ${s.time != null ? fmt(s.time) + "s" : "–"} · 1:${s.ratio ?? "–"}` +
    (v ? ` · ${v}` : "") + (s.rating ? ` · ${"●".repeat(s.rating)}` : "") + (s.starred ? " · starred" : "");
}
function renderHistory(){
  const wrap = $("#history-list");
  if (!S.shots.length){
    wrap.innerHTML = `<div class="empty-note">No shots yet.<br>Your dial-in story will unfold here.</div>`;
    return;
  }
  const sessions = [...S.sessions].sort((a, b) => new Date(b.ts) - new Date(a.ts));
  wrap.innerHTML = sessions.map(ses => {
    const shots = sessionShots(ses.id); if (!shots.length && ses.id !== S.activeSessionId) return "";
    const mode = sessionMode(ses);
    const beanName = ses.remote ? ses.beanName : (byId(S.beans, ses.beanId) || {}).name;
    const gearBits = ses.remote
      ? [ses.grinderName, ses.machineName, ses.barista ? "☺ " + ses.barista : null]
      : [(byId(S.grinders, ses.grinderId) || {}).name, (byId(S.machines, ses.machineId) || {}).name];
    const d = new Date(ses.ts);
    const chart = sessionChartHtml(shots, mode);
    const modeTag = mode !== "espresso" ? `<span class="mode-tag">${MODES[mode].name}</span>` : "";
    const rows = [...shots].reverse().map(s => {
      const v = displayVerdict(s);
      return `
      <div class="shot-row">
        <div class="shot-grind">${s.grind != null ? fmt(s.grind, 2).replace(/\.?0+$/, m => m.includes(".") ? "" : m) || s.grind : "№" + (s.infusion || 1)}</div>
        <div class="shot-mid">
          ${fmt(s.dose)}g → ${fmt(s.yield)}${mode === "tea" ? "ml" : "g"} &nbsp;(1:${s.ratio ?? "–"}) &nbsp;·&nbsp; ${s.time != null ? fmt(s.time) + "s" : "–"}
          ${v ? ` &nbsp;<span class="v-${vClass(v)}">${v}</span>` : ""}
        </div>
        <div class="shot-stars">${"●".repeat(s.rating || 0)}</div>
        <button class="star-btn ${s.starred ? "on" : ""}" data-star="${s.id}" title="Star as recipe" aria-label="Star as recipe"><svg viewBox="0 0 24 24"><path d="M12 3.6l2.5 5.4 5.9.6-4.4 4 1.2 5.8L12 16.5l-5.2 2.9 1.2-5.8-4.4-4 5.9-.6z" fill="${s.starred ? "currentColor" : "none"}" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg></button>
        ${s.notes ? `<div class="shot-note">${escapeHtml(s.notes)}</div>` : ""}
      </div>`; }).join("");
    return `
      <div class="h-session">
        <div class="h-session-head">
          <span class="hb">${modeTag}${escapeHtml(beanName || "Session")}</span>
          <span class="hd">${d.toLocaleDateString([], { month: "short", day: "numeric" })} · ${shots.length} shots</span>
        </div>
        <div class="h-gear">${escapeHtml(gearBits.filter(Boolean).join(" · "))}</div>
        ${chart}
        ${rows}
      </div>`;
  }).join("");
  $$("#history-list .ch-hit").forEach(h => h.addEventListener("click", () => {
    const shot = byId(S.shots, h.dataset.shot); if (!shot) return;
    const card = h.closest(".chart-card");
    card.querySelector(".ch-readout").textContent = chReadout(shot, sessionShots(shot.sessionId));
  }));
  $$("#history-list .star-btn").forEach(b => b.addEventListener("click", () => {
    const shot = byId(S.shots, b.dataset.star); if (!shot) return;
    shot.starred = !shot.starred; save(); renderHistory();
    if (shot.starred) toast("Starred as recipe ✦");
  }));
}
function escapeHtml(s){ return String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c])); }

/* ============================================================
   LIBRARY
   ============================================================ */
const ITEM_FIELDS = {
  bean: [
    { k: "name", label: "Bean name", ph: "Ethiopia Guji Natural" },
    { k: "roaster", label: "Roaster", ph: "Local roastery" },
    { k: "roastDate", label: "Roast date", type: "date" },
  ],
  grinder: [
    { k: "name", label: "Grinder", ph: "Niche Zero" },
    { k: "max", label: "Dial range (highest number)", ph: "90", type: "text", inputmode: "decimal" },
    { k: "step", label: "Dial step size", ph: "1", type: "text", inputmode: "decimal" },
    { k: "unit", label: "Dial unit (optional)", ph: "e.g. clicks" },
  ],
  machine: [
    { k: "name", label: "Machine", ph: "La Marzocco Linea Mini" },
  ],
};
function renderLibrary(){
  const item = (x, type, tag) => `
    <button class="lib-item" data-edit="${type}:${x.id}">
      <span><span class="li-name">${escapeHtml(x.name)}</span>${x.roaster || x.roastDate ? `<span class="li-sub">${escapeHtml(x.roaster || "")}${x.roastDate ? ` · roasted ${x.roastDate}` : ""}</span>` : ""}</span>
      <span class="li-tag">${tag}</span>
    </button>`;
  $("#lib-beans").innerHTML = alive(S.beans).map(b => {
    const d = daysOff(b.roastDate);
    return item(b, "bean", d != null ? `${d}d` : "");
  }).join("") || `<div class="empty-note" style="padding:14px">Add your first bean.</div>`;
  $("#lib-grinders").innerHTML = alive(S.grinders).map(g => item(g, "grinder", `step ${g.step || 1}`)).join("") || `<div class="empty-note" style="padding:14px">Add a grinder.</div>`;
  $("#lib-machines").innerHTML = alive(S.machines).map(m => item(m, "machine", "")).join("") || `<div class="empty-note" style="padding:14px">Add a machine.</div>`;
  $$("#view-library .lib-item").forEach(b => b.addEventListener("click", () => {
    const [type, id] = b.dataset.edit.split(":");
    openItemDialog(type, id);
  }));
}
function collName(type){ return type === "bean" ? "beans" : type === "grinder" ? "grinders" : "machines"; }
let itemCtx = null;
function openItemDialog(type, id){
  itemCtx = { type, id };
  const existing = id ? byId(S[collName(type)], id) : null;
  $("#dlg-item-title").textContent = (existing ? "Edit " : "Add ") + type;
  $("#btn-item-delete").classList.toggle("hidden", !existing);
  $("#dlg-item-fields").innerHTML = ITEM_FIELDS[type].map(f => `
    <label>${f.label}
      <input name="${f.k}" type="${f.type || "text"}" ${f.inputmode ? `inputmode="${f.inputmode}"` : ""}
        placeholder="${f.ph || ""}" value="${existing ? escapeHtml(existing[f.k] ?? "") : ""}" autocomplete="off">
    </label>`).join("");
  $("#dlg-item").showModal();
}
function handleItemClose(){
  const dlg = $("#dlg-item"), val = dlg.returnValue;
  if (!itemCtx) return;
  const coll = S[collName(itemCtx.type)];
  if (val === "delete" && itemCtx.id){
    const item = byId(coll, itemCtx.id);
    if (item){ item.deleted = true; item.updatedAt = Date.now(); }   // soft delete so it propagates to other phones
    save(); renderLibrary(); toast("Deleted"); libSync();
  } else if (val === "ok"){
    const data = {};
    $$("#dlg-item-fields input").forEach(i => data[i.name] = i.value.trim());
    if (!data.name){ itemCtx = null; return; }
    data.updatedAt = Date.now();
    if (itemCtx.id) Object.assign(byId(coll, itemCtx.id), data);
    else {
      // adding a name that already exists updates that item instead of duplicating it
      const twin = alive(coll).find(x => normName(x.name) === normName(data.name));
      if (twin) Object.assign(twin, data);
      else coll.push(Object.assign({ id: uid() }, data));
    }
    save(); renderLibrary(); toast("Saved"); libSync();
    if (sessionDlgOpen){ populateSessionSelects(); $("#dlg-session").showModal(); }
  }
  itemCtx = null;
}

/* ============================================================
   SESSION dialog
   ============================================================ */
let sessionDlgOpen = false;
let dlgMode = "espresso";
function setDlgMode(m){
  dlgMode = m;
  $$("#mode-seg button").forEach(b => b.classList.toggle("on", b.dataset.m === m));
  $("#lbl-bean").firstChild.textContent = m === "espresso" ? "Bean" : "Tea / leaf";
}
function populateSessionSelects(){
  const last = activeSession() || [...S.sessions].reverse().find(s => !s.remote) || {};
  setDlgMode(sessionMode(last));
  const build = (arr, sel) => {
    const hasSel = arr.some(x => x.id === sel);
    return (hasSel ? "" : `<option value="" disabled selected hidden>Choose…</option>`)
      + arr.map(x => `<option value="${x.id}" ${x.id === sel ? "selected" : ""}>${escapeHtml(x.name)}</option>`).join("")
      + `<option value="__add">+ Add new…</option>`;
  };
  $("#sel-bean").innerHTML = build(alive(S.beans), last.beanId);
  $("#sel-grinder").innerHTML = build(alive(S.grinders), last.grinderId);
  $("#sel-machine").innerHTML = build(alive(S.machines), last.machineId);
  $("#in-temp").value = last.waterTemp ?? "";
  $("#in-pressure").value = last.pressure ?? "";
  updateRecipeHint();
}
function updateRecipeHint(){
  const beanId = $("#sel-bean").value;
  const star = beanId && beanId !== "__add" ? starredFor(beanId) : null;
  const el = $("#dlg-recipe");
  el.classList.toggle("hidden", !star);
  if (star) el.textContent = `Starred recipe · grind ${star.grind} · ${fmt(star.dose)}g → ${fmt(star.yield)}g${star.time != null ? " · " + fmt(star.time) + "s" : ""}`;
}
function openSessionDialog(){
  sessionDlgOpen = true;
  const editing = !!activeSession();
  $("#dlg-session-title").textContent = editing ? "Session" : "New session";
  $("#btn-session-ok").textContent = editing ? "Update" : "Start";
  $("#btn-end-session").classList.toggle("hidden", !editing);
  populateSessionSelects();
  $("#dlg-session").showModal();
}
function handleSessionClose(){
  sessionDlgOpen = false;
  const val = $("#dlg-session").returnValue;
  if (val === "end"){
    S.activeSessionId = null; save(); renderDial(); toast("Session ended");
    return;
  }
  if (val !== "ok") return;
  const beanId = $("#sel-bean").value, grinderId = $("#sel-grinder").value, machineId = $("#sel-machine").value;
  if ([beanId, grinderId, machineId].some(v => !v || v === "__add")){
    toast("Pick bean, grinder & machine"); return;
  }
  const t = parseFloat($("#in-temp").value.replace(",", "."));
  const waterTemp = isNaN(t) ? null : t;
  const p = parseFloat($("#in-pressure").value.replace(",", "."));
  const pressure = isNaN(p) ? null : p;
  const ses = activeSession();
  if (ses){ Object.assign(ses, { beanId, grinderId, machineId, waterTemp, pressure, mode: dlgMode }); }
  else {
    const s = { id: uid(), ts: new Date().toISOString(), beanId, grinderId, machineId, waterTemp, pressure, mode: dlgMode };
    S.sessions.push(s); S.activeSessionId = s.id;
  }
  save(); prefillDraft(); renderDial();
}
/* "+ Add new…" inside selects */
["sel-bean", "sel-grinder", "sel-machine"].forEach(id => {
  document.addEventListener("change", e => {
    if (e.target.id !== id) return;
    if (e.target.value === "__add"){
      const type = id === "sel-bean" ? "bean" : id === "sel-grinder" ? "grinder" : "machine";
      $("#dlg-session").close("cancel");
      sessionDlgOpen = true;             // reopen after item saved
      openItemDialog(type, null);
    }
    if (id === "sel-bean") updateRecipeHint();
  });
});

/* ============================================================
   NAV + wiring
   ============================================================ */
function show(view){
  $$(".view").forEach(v => v.classList.toggle("active", v.id === "view-" + view));
  $$(".tab").forEach(t => t.classList.toggle("active", t.dataset.view === view));
  if (view === "history") renderHistory();
  if (view === "library") renderLibrary();
  if (view === "settings"){
    $("#set-barista").value = S.settings.barista;
    $("#set-url").value = S.settings.scriptUrl;
    $("#data-count").textContent = `${S.shots.length} shots · ${S.sessions.length} sessions on this phone · shared library: ${alive(S.beans).length} beans, ${alive(S.grinders).length} grinders, ${alive(S.machines).length} machines.`;
    renderSyncChip();
  }
  window.scrollTo({ top: 0 });
}

function init(){
  $$(".tab").forEach(t => t.addEventListener("click", () => show(t.dataset.view)));
  $("#btn-start-session").addEventListener("click", openSessionDialog);
  $("#session-bar").addEventListener("click", openSessionDialog);
  $("#dlg-session").addEventListener("close", handleSessionClose);
  $("#dlg-item").addEventListener("close", handleItemClose);
  $$("[data-add]").forEach(b => b.addEventListener("click", () => openItemDialog(b.dataset.add, null)));

  $$("#mode-seg button").forEach(b => b.addEventListener("click", () => setDlgMode(b.dataset.m)));

  bindDial();
  bindHoldButton("#grind-minus", () => setGrind(draft.grind - grinderStep()));
  bindHoldButton("#grind-plus", () => setGrind(draft.grind + grinderStep()));
  bindHoldButton("#inf-minus", () => { draft.infusion = Math.max(1, (draft.infusion || 1) - 1); $("#in-infusion").value = draft.infusion; });
  bindHoldButton("#inf-plus",  () => { draft.infusion = (draft.infusion || 1) + 1; $("#in-infusion").value = draft.infusion; });
  $("#in-infusion").addEventListener("change", () => {
    const v = parseInt($("#in-infusion").value, 10);
    draft.infusion = isNaN(v) || v < 1 ? 1 : v;
    $("#in-infusion").value = draft.infusion;
  });
  $("#in-grind").addEventListener("change", () => {
    const v = parseFloat($("#in-grind").value.replace(",", "."));
    setGrind(isNaN(v) ? draft.grind : v);
  });
  bindStepper("#dose-minus", "#dose-plus", "#in-dose", "dose", () => 0.1, 0);
  bindStepper("#yield-minus", "#yield-plus", "#in-yield", "yield", () => 0.5, 0);

  $("#btn-timer").addEventListener("click", toggleTimer);
  $("#in-time").addEventListener("input", sizeTimeInput);
  $("#in-time").addEventListener("change", () => {
    const v = parseFloat($("#in-time").value.replace(",", "."));
    draft.time = isNaN(v) ? null : v;
    sizeTimeInput();
  });
  $$("#verdict-chips .chip").forEach(c => c.addEventListener("click", () => {
    draft.verdict = draft.verdict === c.dataset.v ? null : c.dataset.v;
    renderVerdict();
  }));
  $$("#rating button").forEach(b => b.addEventListener("click", () => {
    draft.rating = draft.rating === +b.dataset.r ? 0 : +b.dataset.r;
    renderRating();
  }));
  $("#in-notes").addEventListener("input", () => draft.notes = $("#in-notes").value);
  $("#btn-log").addEventListener("click", logShot);

  /* settings */
  $("#set-barista").addEventListener("change", () => { S.settings.barista = $("#set-barista").value.trim(); save(); });
  $("#set-url").addEventListener("change", () => { S.settings.scriptUrl = $("#set-url").value.trim(); save(); renderSyncChip(); flushQueue(); libSync(); });
  $("#btn-test-sync").addEventListener("click", testSync);
  $("#btn-default-url").addEventListener("click", () => {
    S.settings.scriptUrl = DEFAULT_SCRIPT_URL; save();
    $("#set-url").value = DEFAULT_SCRIPT_URL;
    renderSyncChip(); flushQueue(); toast("Using the shop endpoint");
  });
  $("#btn-sync-now").addEventListener("click", async () => {
    toast("Syncing…");
    await Promise.all([flushQueue(), libSync(), shotsPull()]);
    if ($("#view-library").classList.contains("active")) renderLibrary();
    show("settings");
    toast("Synced");
  });
  $("#btn-export").addEventListener("click", exportCsv);
  $("#sync-chip").addEventListener("click", () => show("settings"));

  window.addEventListener("online", () => { flushQueue(); libSync(); shotsPull(); });
  // PWAs resumed from the switcher don't relaunch — sync whenever we come back to the foreground
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible"){ flushQueue(); libSync(); shotsPull(); }
  });
  setInterval(flushQueue, 30000);
  setInterval(libSync, 120000);
  setInterval(shotsPull, 120000);

  if (dedupeLibrary()) save();
  if (activeSession()) prefillDraft();
  renderDial(); renderSyncChip();
  flushQueue();
  libSync();
  shotsPull();

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
}
document.addEventListener("DOMContentLoaded", init);
