import { api } from "./api.js";
import { esc, fmt, byName, norm, judgeTotal, toast, formDialog, confirmDialog } from "./util.js";

const $ = (s, r = document) => r.querySelector(s);
const main = $("#app");
const token = new URLSearchParams(location.search).get("t") || "";
const base = `j/${encodeURIComponent(token)}`;

// scores: { [projectId]: score } de este juez
const S = { judge: null, ev: null, projects: [], scores: {}, filter: "" };

init().catch((e) => fatal(e.message));

function fatal(msg) {
  console.error(msg);
  main.innerHTML = `<div class="card narrow"><h2>No se pudo abrir</h2><p class="error">${esc(msg)}</p>
    <p class="muted small">Verifica que el enlace esté completo o pide uno nuevo al organizador.</p></div>`;
}

async function init() {
  if (!token) return fatal("Enlace inválido: falta el código del juez.");
  await load();
  window.addEventListener("hashchange", render);
  render();
}

async function load() {
  const data = await api("GET", base);
  S.judge = data.judge;
  S.ev = data.event;
  S.projects = data.projects.sort(byName);
  S.scores = Object.fromEntries(data.scores.map((s) => [s.projectId, s]));
  document.title = `${S.ev.name} · Juez`;
}

function render() {
  const pid = (location.hash.match(/^#p=(.+)$/) || [])[1];
  const p = pid && S.projects.find((x) => x.id === pid);
  p ? renderScore(p) : renderList();
  window.scrollTo(0, 0);
}

const isComplete = (pid) => judgeTotal(S.ev, S.scores[pid]) != null;

/* ---------- Lista de proyectos ---------- */

function renderList() {
  const e = S.ev;
  const done = S.projects.filter((p) => isComplete(p.id)).length;
  const crit = e.criteria || [];
  main.innerHTML = `
    <div class="card stack">
      <div>
        <h1>${esc(e.name)}</h1>
        <p class="muted">Juez: <b>${esc(S.judge.name)}</b></p>
      </div>
      <div class="progress"><div style="width:${S.projects.length ? (done / S.projects.length) * 100 : 0}%"></div></div>
      <p class="small muted">${done} de ${S.projects.length} proyectos calificados</p>
      ${e.open ? "" : `<p class="banner">El evento está cerrado. Puedes ver tus calificaciones pero ya no editarlas.</p>`}
      <details>
        <summary>Instrucciones y criterios</summary>
        ${e.description ? `<p class="pre">${esc(e.description)}</p>` : ""}
        <ul class="crit-help">${crit.map((c) => `<li><b>${esc(c.name)}</b>${c.description ? ` — ${esc(c.description)}` : ""}</li>`).join("")}</ul>
        <p class="small muted">Cada criterio se califica de 0 a ${e.scaleMax}. Tu feedback escrito se entregará a los equipos sin tus puntajes.</p>
      </details>
    </div>

    <div class="row toolbar">
      <input type="search" id="q" placeholder="Buscar proyecto…" value="${esc(S.filter)}">
      ${e.open ? `<button class="btn primary" id="add">+ Proyecto</button>` : ""}
    </div>
    <div id="plist" class="plist"></div>
    <div class="center"><button class="btn ghost sm" id="reload">↻ Actualizar lista</button></div>`;

  drawList();
  $("#q").oninput = (ev) => { S.filter = ev.target.value; drawList(); };
  $("#reload").onclick = async () => { await load(); renderList(); toast("Lista actualizada"); };
  $("#add")?.addEventListener("click", addProject);
}

function drawList() {
  const q = norm(S.filter);
  const items = S.projects.filter((p) => !q || norm(`${p.name} ${p.team || ""}`).includes(q));
  $("#plist").innerHTML = items.map((p) => {
    const s = S.scores[p.id];
    const total = judgeTotal(S.ev, s);
    const chip = total != null ? `<span class="chip ok">✓ ${fmt(total)}</span>`
      : s ? `<span class="chip warn">Incompleto</span>` : `<span class="chip">Pendiente</span>`;
    return `<a class="pitem" href="#p=${p.id}">
      <div><b>${esc(p.name)}</b>${p.team ? `<div class="muted small">${esc(p.team)}</div>` : ""}</div>${chip}</a>`;
  }).join("") || `<div class="card empty">${S.projects.length ? "Ningún proyecto coincide." : "Aún no hay proyectos. Agrega el primero con “+ Proyecto”."}</div>`;
}

async function addProject() {
  const v = await formDialog({
    title: "Agregar proyecto",
    fields: [
      { name: "name", label: "Nombre del proyecto", required: true },
      { name: "team", label: "Equipo / integrantes" },
      { name: "description", label: "Descripción (opcional)", type: "textarea" },
    ],
    submit: "Agregar y calificar",
  });
  if (!v) return;
  // Recarga por si otro juez ya lo agregó.
  await load();
  const dup = S.projects.find((p) => norm(p.name) === norm(v.name));
  if (dup) {
    const create = await confirmDialog("Ese proyecto ya existe",
      `Ya hay un proyecto llamado <b>${esc(dup.name)}</b>${dup.team ? ` (${esc(dup.team)})` : ""}. ¿Quieres calificar ese en lugar de crear uno nuevo?`,
      "Crear uno nuevo de todos modos", false);
    if (!create) return (location.hash = `#p=${dup.id}`);
  }
  try {
    const p = await api("POST", `${base}/projects`, v);
    S.projects = [...S.projects, p].sort(byName);
    location.hash = `#p=${p.id}`;
  } catch (e) {
    toast(`No se pudo agregar: ${e.message}`, "error");
  }
}

/* ---------- Calificar ---------- */

function renderScore(p) {
  const e = S.ev;
  const prev = S.scores[p.id] || {};
  const cur = { ...(prev.scores || {}) };
  const max = e.scaleMax || 10;
  const crit = e.criteria || [];
  const weighted = new Set(crit.map((c) => Number(c.weight))).size > 1;
  const ro = !e.open;

  main.innerHTML = `
    <a href="#" class="muted small">← Proyectos</a>
    <div class="card">
      <h1>${esc(p.name)}</h1>
      ${p.team ? `<p class="muted">${esc(p.team)}</p>` : ""}
      ${p.description ? `<p class="pre small">${esc(p.description)}</p>` : ""}
    </div>
    ${ro ? `<p class="banner">El evento está cerrado; solo lectura.</p>` : ""}
    <form id="f" class="stack">
      ${crit.map((c) => `<fieldset class="card crit" ${ro ? "disabled" : ""}>
        <legend>${esc(c.name)}${weighted ? ` <span class="muted small">× ${c.weight}</span>` : ""}</legend>
        ${c.description ? `<p class="muted small">${esc(c.description)}</p>` : ""}
        ${max <= 10
          ? `<div class="scale" data-c="${c.id}">${Array.from({ length: max + 1 }, (_, n) =>
              `<button type="button" data-v="${n}" class="${cur[c.id] === n ? "sel" : ""}">${n}</button>`).join("")}</div>`
          : `<input type="number" class="scale-num" data-c="${c.id}" min="0" max="${max}" step="1" value="${cur[c.id] ?? ""}" placeholder="0–${max}">`}
      </fieldset>`).join("")}

      <div class="card total"><span>Total</span><b id="total">—</b><span class="muted small">/ 100</span></div>

      <fieldset class="card stack" ${ro ? "disabled" : ""}>
        <label>Feedback para el equipo
          <textarea name="feedback" rows="5" placeholder="Fortalezas, qué mejorar, recomendaciones…">${esc(prev.feedback || "")}</textarea>
        </label>
        <p class="muted small">Se entregará a los participantes <b>sin</b> tus puntajes.</p>
        <label>Nota privada para el organizador (opcional)
          <textarea name="note" rows="2">${esc(prev.note || "")}</textarea>
        </label>
      </fieldset>
      ${ro ? "" : `<div class="sticky-save"><button class="btn primary block">Guardar calificación</button></div>`}
    </form>`;

  const updateTotal = () => { $("#total").textContent = fmt(judgeTotal(e, { scores: cur })); };
  updateTotal();

  const form = $("#f");
  form.onclick = (ev) => {
    const b = ev.target.closest(".scale button");
    if (!b) return;
    const box = b.parentElement;
    cur[box.dataset.c] = Number(b.dataset.v);
    box.querySelectorAll("button").forEach((x) => x.classList.toggle("sel", x === b));
    updateTotal();
  };
  form.oninput = (ev) => {
    if (!ev.target.matches(".scale-num")) return;
    const v = ev.target.value === "" ? NaN : Number(ev.target.value);
    if (Number.isFinite(v) && v >= 0 && v <= max) cur[ev.target.dataset.c] = v;
    else delete cur[ev.target.dataset.c];
    updateTotal();
  };
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const missing = crit.filter((c) => typeof cur[c.id] !== "number");
    if (missing.length) return toast(`Falta calificar: ${missing.map((c) => c.name).join(", ")}`, "error");
    const fd = new FormData(form);
    const data = {
      scores: Object.fromEntries(crit.map((c) => [c.id, cur[c.id]])),
      feedback: String(fd.get("feedback") || "").trim(),
      note: String(fd.get("note") || "").trim(),
    };
    const btn = form.querySelector(".sticky-save button");
    btn.disabled = true;
    try {
      S.scores[p.id] = await api("PUT", `${base}/scores/${encodeURIComponent(p.id)}`, data);
      toast("Calificación guardada");
      location.hash = "";
    } catch (err) {
      toast(`No se pudo guardar: ${err.message}`, "error");
      btn.disabled = false;
    }
  };
}
