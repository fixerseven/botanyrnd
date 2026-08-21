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
function sessionShots(sid){ return S.shots.filter(s => s.sessionId === sid); }
function lastShotIn(sid){ const arr = sessionShots(sid); return arr[arr.length - 1] || null; }
function starredFor(beanId){
  return [...S.shots].reverse().find(s => s.starred && byId(S.sessions, s.sessionId)?.beanId === beanId) || null;
}

/* ---------- draft (current shot being composed) ---------- */
let draft = { grind: 5.0, dose: 18.0, yield: 36.0, time: null, verdict: null, rating: 0, notes: "" };
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
  const src = last || star;
  if (src){
    draft.grind = src.grind; draft.dose = src.dose; draft.yield = src.yield;
  } else {
    // last shot ever on this grinder, else defaults
    const prior = [...S.shots].reverse().find(s => byId(S.sessions, s.sessionId)?.grinderId === ses.grinderId);
    draft.grind = prior ? prior.grind : Math.round(grinderMax() / 3);
    draft.dose = prior ? prior.dose : 18.0;
    draft.yield = prior ? prior.yield : 36.0;
  }
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
  $("#sb-gear").textContent = [gr?.name, ma?.name, ses.waterTemp ? ses.waterTemp + "°C" : null].filter(Boolean).join("  ·  ");
  const n = sessionShots(ses.id).length;
  $("#sb-count").textContent = `${n} shot${n === 1 ? "" : "s"}`;

  const gu = gr?.unit ? gr.unit : "";
  $("#grind-unit").textContent = `0–${grinderMax()}${gu ? " · " + gu : ""}`;

  buildDialSvg();
  setGrind(draft.grind);
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
  const hints = { sour: "Under-extracted — try a finer grind.", bitter: "Over-extracted — try a coarser grind.", balanced: "Lovely. Star it in History." };
  $("#verdict-hint").textContent = draft.verdict ? hints[draft.verdict] : "";
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
  const shot = {
    id: uid(), sessionId: ses.id, ts: new Date().toISOString(),
    grind: draft.grind, dose: draft.dose, yield: draft.yield,
    time: draft.time, ratio: draft.dose > 0 ? +(draft.yield / draft.dose).toFixed(2) : null,
    verdict: draft.verdict, rating: draft.rating, notes: draft.notes, starred: false,
  };
  S.shots.push(shot);
  S.queue.push(shot.id);
  save();
  const n = sessionShots(ses.id).length;
  toast(`Shot ${n} logged — ${fmt(shot.grind, stepDecimals())} · ${shot.time != null ? fmt(shot.time) + "s" : "no time"}`);
  lastLoggedGrind = shot.grind;
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
  const dt = new Date(shot.ts);
  return [
    shot.ts, dt.toLocaleDateString(), dt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    S.settings.barista || "", "espresso",
    (byId(S.machines, ses.machineId) || {}).name || "",
    (byId(S.grinders, ses.grinderId) || {}).name || "",
    bean.name || "", bean.roaster || "", bean.roastDate || "",
    bean.roastDate ? daysOff(bean.roastDate) : "",
    ses.waterTemp ?? "",
    shot.grind, shot.dose, shot.yield, shot.ratio ?? "", shot.time ?? "",
    shot.verdict || "", shot.rating || "", shot.notes || "",
    ses.id || "", shot.id,
  ];
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
  const head = ["timestamp","date","time","barista","mode","machine","grinder","bean","roaster","roast_date","days_off_roast","water_temp_c","grind","dose_g","yield_g","ratio","time_s","verdict","rating","notes","session_id","shot_id"];
  const esc = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const csv = [head.join(","), ...S.shots.map(s => shotRow(s).map(esc).join(","))].join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = `botany-shots-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click(); URL.revokeObjectURL(a.href);
}

/* ============================================================
   HISTORY
   ============================================================ */
function renderHistory(){
  const wrap = $("#history-list");
  if (!S.shots.length){
    wrap.innerHTML = `<div class="empty-note">No shots yet.<br>Your dial-in story will unfold here.</div>`;
    return;
  }
  const sessions = [...S.sessions].reverse();
  wrap.innerHTML = sessions.map(ses => {
    const shots = sessionShots(ses.id); if (!shots.length && ses.id !== S.activeSessionId) return "";
    const bean = byId(S.beans, ses.beanId) || {}, gr = byId(S.grinders, ses.grinderId) || {}, ma = byId(S.machines, ses.machineId) || {};
    const d = new Date(ses.ts);
    const rows = [...shots].reverse().map(s => `
      <div class="shot-row">
        <div class="shot-grind">${fmt(s.grind, 2).replace(/\.?0+$/, m => m.includes(".") ? "" : m) || s.grind}</div>
        <div class="shot-mid">
          ${fmt(s.dose)}g → ${fmt(s.yield)}g &nbsp;(1:${s.ratio ?? "–"}) &nbsp;·&nbsp; ${s.time != null ? fmt(s.time) + "s" : "–"}
          ${s.verdict ? ` &nbsp;<span class="v-${s.verdict}">${s.verdict}</span>` : ""}
        </div>
        <div class="shot-stars">${"●".repeat(s.rating || 0)}</div>
        <button class="star-btn ${s.starred ? "on" : ""}" data-star="${s.id}" title="Star as recipe" aria-label="Star as recipe"><svg viewBox="0 0 24 24"><path d="M12 3.6l2.5 5.4 5.9.6-4.4 4 1.2 5.8L12 16.5l-5.2 2.9 1.2-5.8-4.4-4 5.9-.6z" fill="${s.starred ? "currentColor" : "none"}" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg></button>
        ${s.notes ? `<div class="shot-note">${escapeHtml(s.notes)}</div>` : ""}
      </div>`).join("");
    return `
      <div class="h-session">
        <div class="h-session-head">
          <span class="hb">${escapeHtml(bean.name || "Session")}</span>
          <span class="hd">${d.toLocaleDateString([], { month: "short", day: "numeric" })} · ${shots.length} shots</span>
        </div>
        <div class="h-gear">${escapeHtml([gr.name, ma.name].filter(Boolean).join(" · "))}</div>
        ${rows}
      </div>`;
  }).join("");
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
  $("#lib-beans").innerHTML = S.beans.map(b => {
    const d = daysOff(b.roastDate);
    return item(b, "bean", d != null ? `${d}d` : "");
  }).join("") || `<div class="empty-note" style="padding:14px">Add your first bean.</div>`;
  $("#lib-grinders").innerHTML = S.grinders.map(g => item(g, "grinder", `step ${g.step || 0.1}`)).join("") || `<div class="empty-note" style="padding:14px">Add a grinder.</div>`;
  $("#lib-machines").innerHTML = S.machines.map(m => item(m, "machine", "")).join("") || `<div class="empty-note" style="padding:14px">Add a machine.</div>`;
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
    S[collName(itemCtx.type)] = coll.filter(x => x.id !== itemCtx.id); save();
    renderLibrary(); toast("Deleted");
  } else if (val === "ok"){
    const data = {};
    $$("#dlg-item-fields input").forEach(i => data[i.name] = i.value.trim());
    if (!data.name){ itemCtx = null; return; }
    if (itemCtx.id) Object.assign(byId(coll, itemCtx.id), data);
    else coll.push(Object.assign({ id: uid() }, data));
    save(); renderLibrary(); toast("Saved");
    if (sessionDlgOpen){ populateSessionSelects(); $("#dlg-session").showModal(); }
  }
  itemCtx = null;
}

/* ============================================================
   SESSION dialog
   ============================================================ */
let sessionDlgOpen = false;
function populateSessionSelects(){
  const last = activeSession() || S.sessions[S.sessions.length - 1] || {};
  const build = (arr, sel) => {
    const hasSel = arr.some(x => x.id === sel);
    return (hasSel ? "" : `<option value="" disabled selected hidden>Choose…</option>`)
      + arr.map(x => `<option value="${x.id}" ${x.id === sel ? "selected" : ""}>${escapeHtml(x.name)}</option>`).join("")
      + `<option value="__add">+ Add new…</option>`;
  };
  $("#sel-bean").innerHTML = build(S.beans, last.beanId);
  $("#sel-grinder").innerHTML = build(S.grinders, last.grinderId);
  $("#sel-machine").innerHTML = build(S.machines, last.machineId);
  $("#in-temp").value = last.waterTemp ?? "";
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
  const ses = activeSession();
  if (ses){ Object.assign(ses, { beanId, grinderId, machineId, waterTemp }); }
  else {
    const s = { id: uid(), ts: new Date().toISOString(), beanId, grinderId, machineId, waterTemp };
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
    $("#data-count").textContent = `${S.shots.length} shots · ${S.sessions.length} sessions on this phone.`;
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

  bindDial();
  bindHoldButton("#grind-minus", () => setGrind(draft.grind - grinderStep()));
  bindHoldButton("#grind-plus", () => setGrind(draft.grind + grinderStep()));
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
  $("#set-url").addEventListener("change", () => { S.settings.scriptUrl = $("#set-url").value.trim(); save(); renderSyncChip(); flushQueue(); });
  $("#btn-test-sync").addEventListener("click", testSync);
  $("#btn-default-url").addEventListener("click", () => {
    S.settings.scriptUrl = DEFAULT_SCRIPT_URL; save();
    $("#set-url").value = DEFAULT_SCRIPT_URL;
    renderSyncChip(); flushQueue(); toast("Using the shop endpoint");
  });
  $("#btn-sync-now").addEventListener("click", () => { flushQueue(); });
  $("#btn-export").addEventListener("click", exportCsv);
  $("#sync-chip").addEventListener("click", () => show("settings"));

  window.addEventListener("online", flushQueue);
  setInterval(flushQueue, 30000);

  if (activeSession()) prefillDraft();
  renderDial(); renderSyncChip();
  flushQueue();

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
}
document.addEventListener("DOMContentLoaded", init);
