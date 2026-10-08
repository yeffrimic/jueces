import { api } from "./api.js";
import { parseEventMd, eventToMd } from "./eventmd.js";
import {
  esc, fmt, byName, randomToken, judgeTotal, toCSV, download, fileSafe, copyText, toast, formDialog, confirmDialog,
} from "./util.js";

const $ = (s, r = document) => r.querySelector(s);
const main = $("#app");
const userBox = $("#user-box");

// scores: { [judgeToken]: { [projectId]: score } }
const S = { authed: false, events: [], eid: null, tab: "resultados", ev: null, judges: [], projects: [], scores: {}, fbNames: false };
const TABS = [["resultados", "Resultados"], ["proyectos", "Proyectos"], ["jueces", "Jueces"], ["feedback", "Feedback"], ["config", "Configuración"]];

window.addEventListener("hashchange", () => S.authed && route().catch(handleError));
start();

async function start() {
  try {
    await api("GET", "me");
    S.authed = true;
  } catch (e) {
    if (e.status !== 401) return showError(e);
    S.authed = false;
  }
  renderUserBox();
  if (!S.authed) return renderLogin();
  try {
    await loadEvents();
    S.eid = null;
    await route();
  } catch (e) {
    handleError(e);
  }
}

// Si la sesión expiró, vuelve al login; si no, muestra el error.
function handleError(e) {
  if (e.status === 401) {
    S.authed = false;
    renderUserBox();
    renderLogin("Tu sesión expiró. Vuelve a entrar.");
  } else showError(e);
}

function showError(e) {
  console.error(e);
  main.innerHTML = `<div class="card narrow"><p class="error">${esc(e.message)}</p></div>`;
}

// Atrapa errores de los manejadores de botones (sesión expirada, validación del servidor, red).
window.addEventListener("unhandledrejection", (ev) => {
  ev.preventDefault();
  const e = ev.reason || {};
  if (e.status === 401) handleError(e);
  else toast(e.message || "Ocurrió un error", "error");
});

/* ---------- Sesión ---------- */

function renderUserBox() {
  userBox.innerHTML = S.authed ? `<button class="btn ghost sm" id="logout">Salir</button>` : "";
  $("#logout")?.addEventListener("click", async () => {
    await api("POST", "logout", {});
    S.authed = false;
    S.eid = null;
    renderUserBox();
    renderLogin();
  });
}

function renderLogin(msg = "") {
  main.innerHTML = `<form class="card narrow stack" id="login">
    <h2>Panel del organizador</h2>
    ${msg ? `<p class="error">${esc(msg)}</p>` : ""}
    <label>Contraseña<input type="password" name="password" required autocomplete="current-password" autofocus></label>
    <div><button class="btn primary">Entrar</button></div>
  </form>`;
  $("#login").onsubmit = async (ev) => {
    ev.preventDefault();
    const btn = ev.target.querySelector("button");
    btn.disabled = true;
    try {
      await api("POST", "login", { password: new FormData(ev.target).get("password") });
      start();
    } catch (e) {
      renderLogin(e.message);
    }
  };
}

/* ---------- Datos ---------- */

async function loadEvents() {
  S.events = await api("GET", "events");
}

async function loadEvent(eid) {
  const { event, judges, projects, scores } = await api("GET", `events/${encodeURIComponent(eid)}`);
  S.ev = event;
  S.judges = judges.sort(byName);
  S.projects = projects.sort(byName);
  S.scores = Object.fromEntries(judges.map((j) => [j.id, {}]));
  for (const s of scores) (S.scores[s.judgeId] ||= {})[s.projectId] = s;
}

const judgeLink = (token) => new URL(`judge?t=${token}`, location.href.split("#")[0]).href;
const evalCount = (pid) => S.judges.filter((j) => S.scores[j.id]?.[pid]).length;

/* ---------- Navegación ---------- */

async function route() {
  const [, eid, tab] = location.hash.match(/^#\/e\/([^/]+)\/?([^/]*)/) || [];
  if (!eid) {
    S.eid = null;
    return renderHome();
  }
  S.tab = TABS.some(([k]) => k === tab) ? tab : "resultados";
  if (S.eid !== eid) {
    S.eid = eid;
    main.innerHTML = `<p class="muted">Cargando…</p>`;
    await loadEvent(eid);
  }
  renderEvent();
}

function renderHome() {
  main.innerHTML = `
    <div class="row between wrap">
      <h1>Eventos</h1>
      <div class="row wrap">
        <a class="btn ghost sm" href="plantilla-evento.md" download>Descargar plantilla .md</a>
        <button class="btn" id="import-ev">Importar .md</button>
        <button class="btn primary" id="new-ev">+ Nuevo evento</button>
      </div>
    </div>
    <p class="muted small">Puedes crear un evento completo (instrucciones, escala, criterios, jueces y proyectos) subiendo un archivo .md o arrastrándolo aquí.</p>
    <input type="file" id="md-file" accept=".md,.markdown,.txt,text/markdown,text/plain" hidden>
    ${S.events.length
      ? `<div class="grid">${S.events.map((e) => `
          <a class="card link" href="#/e/${e.id}">
            <h3>${esc(e.name)}</h3>
            <p class="muted small">${(e.criteria || []).length} criterios · escala 0–${e.scaleMax || 10}</p>
            <span class="chip ${e.open ? "ok" : ""}">${e.open ? "Abierto" : "Cerrado"}</span>
          </a>`).join("")}</div>`
      : `<div class="card empty">Aún no hay eventos. Crea el primero.</div>`}`;
  $("#new-ev").onclick = async () => {
    const v = await formDialog({
      title: "Nuevo evento",
      fields: [
        { name: "name", label: "Nombre del evento", required: true },
        { name: "description", label: "Instrucciones para los jueces (opcional)", type: "textarea" },
      ],
      submit: "Crear",
    });
    if (!v) return;
    const ref = await api("POST", "events", { name: v.name, description: v.description });
    await loadEvents();
    location.hash = `#/e/${ref.id}/config`;
  };
  const file = $("#md-file");
  $("#import-ev").onclick = () => file.click();
  file.onchange = () => {
    if (file.files[0]) importMd(file.files[0]);
    file.value = "";
  };
  // Solo en la lista de eventos (los handlers quedan en <main> al navegar).
  main.ondragover = (ev) => {
    if (S.eid) return;
    ev.preventDefault();
    main.classList.add("dropping");
  };
  main.ondragleave = () => main.classList.remove("dropping");
  main.ondrop = (ev) => {
    if (S.eid) return;
    ev.preventDefault();
    main.classList.remove("dropping");
    if (ev.dataTransfer.files[0]) importMd(ev.dataTransfer.files[0]);
  };
}

async function importMd(file) {
  if (file.size > 400 * 1024) return toast("El archivo es demasiado grande (máx. 400 KB)", "error");
  let parsed;
  try {
    parsed = parseEventMd(await file.text());
  } catch (e) {
    return toast(`No se pudo leer ${file.name}: ${e.message}`, "error");
  }
  const { event: e, warnings } = parsed;
  const list = (items, max = 12) =>
    items.length
      ? `<ul class="preview">${items.slice(0, max).map((x) => `<li>${x}</li>`).join("")}${items.length > max ? `<li class="muted">…y ${items.length - max} más</li>` : ""}</ul>`
      : `<p class="muted small">Ninguno</p>`;
  const ok = await confirmDialog(`Crear "${e.name}"`, `
    <span class="muted small">Archivo: ${esc(file.name)}</span><br>
    Escala 0–${e.scaleMax ?? 10} · ${e.open === false ? "cerrado" : "abierto"}
    ${e.description ? `<details><summary>Instrucciones para jueces</summary><p class="pre small">${esc(e.description)}</p></details>` : ""}
    <b>Criterios (${e.criteria ? e.criteria.length : "por defecto"})</b>
    ${e.criteria ? list(e.criteria.map((c) => `${esc(c.name)} <span class="muted">× ${c.weight}</span>${c.description ? `<div class="muted small">${esc(c.description)}</div>` : ""}`), 30) : ""}
    <b>Jueces (${e.judges.length})</b>${list(e.judges.map(esc))}
    <b>Proyectos (${e.projects.length})</b>${list(e.projects.map((p) => `${esc(p.name)}${p.team ? ` <span class="muted">· ${esc(p.team)}</span>` : ""}`))}
    ${warnings.length ? `<div class="banner small"><b>Avisos:</b><ul>${warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul></div>` : ""}`,
  "Crear evento", false);
  if (!ok) return;
  const res = await api("POST", "events/import", e);
  await loadEvents();
  toast(`Evento creado con ${res.judges} jueces y ${res.projects} proyectos`);
  location.hash = `#/e/${res.event.id}/${res.judges ? "jueces" : "config"}`;
}

function renderEvent() {
  const e = S.ev;
  main.innerHTML = `
    <a href="#/" class="muted small">← Eventos</a>
    <div class="row between wrap">
      <div>
        <h1>${esc(e.name)}</h1>
        <span class="chip ${e.open ? "ok" : ""}">${e.open ? "Abierto · los jueces pueden calificar" : "Cerrado · solo lectura para jueces"}</span>
      </div>
      <div class="row">
        <button class="btn" id="toggle-open">${e.open ? "Cerrar evento" : "Reabrir evento"}</button>
        <button class="btn" id="refresh" title="Volver a cargar datos">↻ Actualizar</button>
      </div>
    </div>
    <nav class="tabs">${TABS.map(([k, l]) => `<a href="#/e/${e.id}/${k}" class="${S.tab === k ? "active" : ""}">${l}</a>`).join("")}</nav>
    <section id="tab"></section>`;
  $("#refresh").onclick = async () => {
    await loadEvent(e.id);
    renderEvent();
    toast("Datos actualizados");
  };
  $("#toggle-open").onclick = async () => {
    Object.assign(e, await api("PATCH", `events/${e.id}`, { open: !e.open }));
    syncEventList();
    renderEvent();
  };
  ({ resultados: tabResults, proyectos: tabProjects, jueces: tabJudges, feedback: tabFeedback, config: tabConfig })[S.tab]($("#tab"));
}

function syncEventList() {
  const i = S.events.findIndex((x) => x.id === S.ev.id);
  if (i >= 0) S.events[i] = { ...S.events[i], ...S.ev };
}

/* ---------- Resultados ---------- */

function computeResults() {
  const crit = S.ev.criteria || [];
  const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const R = S.projects.map((p) => {
    const evals = S.judges.map((j) => ({ j, s: S.scores[j.id]?.[p.id] })).filter((x) => x.s);
    const totals = evals.map((x) => judgeTotal(S.ev, x.s)).filter((v) => v != null);
    const perCrit = Object.fromEntries(crit.map((c) => [
      c.id, avg(evals.map((x) => x.s.scores?.[c.id]).filter((v) => typeof v === "number")),
    ]));
    return {
      p, evals, perCrit, n: totals.length, avg: avg(totals),
      min: totals.length ? Math.min(...totals) : null, max: totals.length ? Math.max(...totals) : null,
    };
  }).sort((a, b) => (b.avg ?? -1) - (a.avg ?? -1) || byName(a.p, b.p));
  // Empates comparten posición.
  let rank = 0, prev = null;
  R.forEach((r, i) => {
    if (r.avg == null) return (r.rank = null);
    if (prev === null || Math.abs(r.avg - prev) > 1e-9) rank = i + 1;
    r.rank = rank;
    prev = r.avg;
  });
  return R;
}

function tabResults(el) {
  const crit = S.ev.criteria || [];
  const R = computeResults();
  const done = R.reduce((a, r) => a + r.n, 0);
  const expected = S.projects.length * S.judges.length;
  el.innerHTML = `
    <div class="stats">
      <div class="stat"><b>${S.projects.length}</b><span>proyectos</span></div>
      <div class="stat"><b>${S.judges.length}</b><span>jueces</span></div>
      <div class="stat"><b>${done}${expected ? ` / ${expected}` : ""}</b><span>evaluaciones completas</span></div>
    </div>

    <div class="row between wrap">
      <h2>Ranking</h2>
      <div class="row"><button class="btn sm" id="csv-rank">CSV ranking</button><button class="btn sm" id="csv-detail">CSV detalle</button></div>
    </div>
    <p class="muted small">Puntaje 0–100: para cada juez se calcula el total ponderado (nota ÷ ${S.ev.scaleMax} × peso) y luego se promedia entre los jueces que evaluaron el proyecto. Las columnas de criterios muestran el promedio en escala 0–${S.ev.scaleMax}.</p>
    <div class="table-wrap"><table>
      <thead><tr><th>#</th><th>Proyecto</th><th class="num">Puntaje</th><th class="num">Jueces</th>
        ${crit.map((c) => `<th class="num" title="${esc(c.description || "")}">${esc(c.name)}</th>`).join("")}
        <th class="num">Mín–Máx</th></tr></thead>
      <tbody>${R.map((r) => `<tr class="${r.rank && r.rank <= 3 ? "top" : ""}">
        <td>${r.rank ?? "—"}</td>
        <td><b>${esc(r.p.name)}</b>${r.p.team ? `<div class="muted small">${esc(r.p.team)}</div>` : ""}</td>
        <td class="num big">${fmt(r.avg)}</td>
        <td class="num">${r.n}/${S.judges.length}</td>
        ${crit.map((c) => `<td class="num">${fmt(r.perCrit[c.id])}</td>`).join("")}
        <td class="num muted small">${r.n ? `${fmt(r.min)}–${fmt(r.max)}` : "—"}</td>
      </tr>`).join("") || `<tr><td colspan="99" class="empty">Sin proyectos todavía.</td></tr>`}</tbody>
    </table></div>

    <h2>Matriz jueces × proyectos</h2>
    <div class="table-wrap"><table>
      <thead><tr><th>Proyecto</th>${S.judges.map((j) => `<th class="num">${esc(j.name)}</th>`).join("")}</tr></thead>
      <tbody>${R.map((r) => `<tr><td>${esc(r.p.name)}</td>${S.judges.map((j) => {
        const s = S.scores[j.id]?.[r.p.id];
        return `<td class="num">${s ? fmt(judgeTotal(S.ev, s)) : `<span class="muted">·</span>`}</td>`;
      }).join("")}</tr>`).join("")}</tbody>
    </table></div>

    <h2>Detalle por proyecto</h2>
    ${R.map((r) => `<details class="card">
      <summary><b>${esc(r.p.name)}</b> <span class="muted">— ${fmt(r.avg)} · ${r.evals.length} evaluaciones</span></summary>
      ${r.evals.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Juez</th>${crit.map((c) => `<th class="num">${esc(c.name)}</th>`).join("")}<th class="num">Total</th><th>Feedback</th><th>Nota privada</th></tr></thead>
        <tbody>${r.evals.map(({ j, s }) => `<tr>
          <td>${esc(j.name)}</td>
          ${crit.map((c) => `<td class="num">${s.scores?.[c.id] ?? "—"}</td>`).join("")}
          <td class="num"><b>${fmt(judgeTotal(S.ev, s))}</b></td>
          <td class="pre">${esc(s.feedback || "")}</td>
          <td class="pre muted">${esc(s.note || "")}</td>
        </tr>`).join("")}</tbody>
      </table></div>` : `<p class="muted">Sin evaluaciones.</p>`}
    </details>`).join("")}`;

  const base = fileSafe(S.ev.name);
  $("#csv-rank").onclick = () => download(`${base}-ranking.csv`, toCSV([
    ["Posición", "Proyecto", "Equipo", "Puntaje (0-100)", "Evaluaciones", ...crit.map((c) => c.name), "Mínimo", "Máximo"],
    ...R.map((r) => [r.rank ?? "", r.p.name, r.p.team || "", fmt(r.avg, 2), r.n,
      ...crit.map((c) => fmt(r.perCrit[c.id], 2)), fmt(r.min, 2), fmt(r.max, 2)]),
  ]), "text/csv");
  $("#csv-detail").onclick = () => download(`${base}-detalle.csv`, toCSV([
    ["Proyecto", "Equipo", "Juez", ...crit.map((c) => c.name), "Total (0-100)", "Feedback", "Nota privada"],
    ...R.flatMap((r) => r.evals.map(({ j, s }) => [r.p.name, r.p.team || "", j.name,
      ...crit.map((c) => s.scores?.[c.id] ?? ""), fmt(judgeTotal(S.ev, s), 2), s.feedback || "", s.note || ""])),
  ]), "text/csv");
}

/* ---------- Proyectos ---------- */

const projectFields = (p = {}) => [
  { name: "name", label: "Nombre del proyecto", required: true, value: p.name },
  { name: "team", label: "Equipo / integrantes", value: p.team },
  { name: "description", label: "Descripción", type: "textarea", value: p.description },
];

function tabProjects(el) {
  el.innerHTML = `
    <div class="row between"><h2>Proyectos (${S.projects.length})</h2><button class="btn primary" id="add-p">+ Agregar proyecto</button></div>
    <p class="muted small">Los jueces también pueden agregar proyectos desde su enlace mientras el evento esté abierto.</p>
    <div class="table-wrap"><table>
      <thead><tr><th>Proyecto</th><th>Equipo</th><th>Agregado por</th><th class="num">Evaluaciones</th><th></th></tr></thead>
      <tbody>${S.projects.map((p) => `<tr>
        <td><b>${esc(p.name)}</b>${p.description ? `<div class="muted small pre">${esc(p.description)}</div>` : ""}</td>
        <td>${esc(p.team || "")}</td>
        <td class="muted small">${esc(p.createdByName || "")}</td>
        <td class="num">${evalCount(p.id)}/${S.judges.length}</td>
        <td class="actions"><button class="btn ghost sm" data-edit="${p.id}">Editar</button><button class="btn ghost sm danger" data-del="${p.id}">Eliminar</button></td>
      </tr>`).join("") || `<tr><td colspan="5" class="empty">Sin proyectos.</td></tr>`}</tbody>
    </table></div>`;

  $("#add-p").onclick = async () => {
    const v = await formDialog({ title: "Agregar proyecto", fields: projectFields(), submit: "Agregar" });
    if (!v) return;
    const p = await api("POST", `events/${S.ev.id}/projects`, v);
    S.projects = [...S.projects, p].sort(byName);
    renderEvent();
  };
  el.onclick = async (ev) => {
    const { edit, del } = ev.target.dataset;
    if (edit) {
      const p = S.projects.find((x) => x.id === edit);
      const v = await formDialog({ title: "Editar proyecto", fields: projectFields(p) });
      if (!v) return;
      Object.assign(p, await api("PATCH", `projects/${edit}`, v));
      S.projects.sort(byName);
      renderEvent();
    }
    if (del) {
      const p = S.projects.find((x) => x.id === del);
      const ok = await confirmDialog("Eliminar proyecto",
        `Se eliminará <b>${esc(p.name)}</b> y sus ${evalCount(del)} evaluaciones. No se puede deshacer.`, "Eliminar");
      if (!ok) return;
      await api("DELETE", `projects/${del}`);
      S.projects = S.projects.filter((x) => x.id !== del);
      S.judges.forEach((j) => delete S.scores[j.id]?.[del]);
      renderEvent();
    }
  };
}

/* ---------- Jueces ---------- */

function tabJudges(el) {
  el.innerHTML = `
    <div class="row between"><h2>Jueces (${S.judges.length})</h2>
      <div class="row"><button class="btn sm" id="copy-all" ${S.judges.length ? "" : "disabled"}>Copiar todos los enlaces</button>
      <button class="btn primary" id="add-j">+ Agregar juez</button></div></div>
    <p class="muted small">Cada juez recibe un enlace único y privado. Quien tenga el enlace puede calificar como ese juez, así que compártelo solo con esa persona.</p>
    ${S.judges.map((j) => `<div class="card judge">
      <div class="row between wrap">
        <div><h3>${esc(j.name)}</h3><span class="muted small">${Object.keys(S.scores[j.id] || {}).length} de ${S.projects.length} proyectos calificados</span></div>
        <div class="row"><button class="btn ghost sm" data-rename="${j.id}">Renombrar</button><button class="btn ghost sm danger" data-del="${j.id}">Eliminar</button></div>
      </div>
      <div class="row link-row">
        <input readonly class="select-all" value="${esc(judgeLink(j.id))}">
        <button class="btn sm" data-copy="${j.id}">Copiar</button>
        <a class="btn ghost sm" href="${esc(judgeLink(j.id))}" target="_blank" rel="noopener">Abrir</a>
      </div>
    </div>`).join("") || `<div class="card empty">Agrega jueces para generar sus enlaces.</div>`}`;

  $("#add-j").onclick = async () => {
    const v = await formDialog({ title: "Agregar juez", fields: [{ name: "name", label: "Nombre del juez", required: true }], submit: "Agregar" });
    if (!v) return;
    const j = await api("POST", `events/${S.ev.id}/judges`, { name: v.name });
    S.judges = [...S.judges, j].sort(byName);
    S.scores[j.id] = {};
    renderEvent();
  };
  $("#copy-all").onclick = () => copyText(S.judges.map((j) => `${j.name}: ${judgeLink(j.id)}`).join("\n"));
  el.onclick = async (ev) => {
    if (ev.target.matches(".select-all")) return ev.target.select();
    const { copy, rename, del } = ev.target.dataset;
    if (copy) copyText(judgeLink(copy));
    if (rename) {
      const j = S.judges.find((x) => x.id === rename);
      const v = await formDialog({ title: "Renombrar juez", fields: [{ name: "name", label: "Nombre", required: true, value: j.name }] });
      if (!v) return;
      Object.assign(j, await api("PATCH", `judges/${rename}`, { name: v.name }));
      renderEvent();
    }
    if (del) {
      const j = S.judges.find((x) => x.id === del);
      const n = Object.keys(S.scores[del] || {}).length;
      const ok = await confirmDialog("Eliminar juez",
        `Se eliminará a <b>${esc(j.name)}</b>, su enlace dejará de funcionar y se borrarán sus ${n} calificaciones.`, "Eliminar");
      if (!ok) return;
      await api("DELETE", `judges/${del}`);
      S.judges = S.judges.filter((x) => x.id !== del);
      delete S.scores[del];
      renderEvent();
    }
  };
}

/* ---------- Feedback ---------- */

function feedbackItems() {
  return S.projects.map((p) => ({
    p,
    fb: S.judges.map((j) => ({ j, t: (S.scores[j.id]?.[p.id]?.feedback || "").trim() })).filter((x) => x.t),
  }));
}

const fbLine = (f, names) => `${names ? `${f.j.name}: ` : ""}${f.t}`;

function tabFeedback(el) {
  const items = feedbackItems();
  const names = S.fbNames;
  el.innerHTML = `
    <div class="row between wrap">
      <p class="muted">Comentarios para entregar a los participantes. <b>No incluye puntajes ni notas privadas.</b></p>
      <div class="row wrap">
        <label class="check"><input type="checkbox" id="fb-names" ${names ? "checked" : ""}> Mostrar nombre del juez</label>
        <button class="btn sm" id="fb-md">Descargar .md</button>
        <button class="btn sm" id="fb-csv">Descargar CSV</button>
        <button class="btn sm" id="fb-print">Imprimir / PDF</button>
      </div>
    </div>
    ${items.map((it, i) => `<div class="card">
      <div class="row between">
        <div><h3>${esc(it.p.name)}</h3>${it.p.team ? `<div class="muted small">${esc(it.p.team)}</div>` : ""}</div>
        <button class="btn ghost sm" data-copy="${i}" ${it.fb.length ? "" : "disabled"}>Copiar</button>
      </div>
      ${it.fb.length
        ? `<ul class="feedback">${it.fb.map((f) => `<li>${names ? `<b>${esc(f.j.name)}:</b> ` : ""}<span class="pre">${esc(f.t)}</span></li>`).join("")}</ul>`
        : `<p class="muted">Sin feedback todavía.</p>`}
    </div>`).join("") || `<div class="card empty">Sin proyectos.</div>`}`;

  const base = fileSafe(S.ev.name);
  $("#fb-names").onchange = (ev) => { S.fbNames = ev.target.checked; tabFeedback(el); };
  el.onclick = (ev) => {
    const i = ev.target.dataset.copy;
    if (i == null) return;
    const it = items[i];
    copyText(`${it.p.name}${it.p.team ? ` (${it.p.team})` : ""}\n\n${it.fb.map((f) => `- ${fbLine(f, names)}`).join("\n")}`);
  };
  $("#fb-md").onclick = () => download(`${base}-feedback.md`,
    `# Feedback · ${S.ev.name}\n\n` + items.map((it) =>
      `## ${it.p.name}\n${it.p.team ? `_${it.p.team}_\n` : ""}\n${it.fb.length ? it.fb.map((f) => `- ${fbLine(f, names).replace(/\n/g, "\n  ")}`).join("\n") : "_Sin comentarios._"}\n`,
    ).join("\n"), "text/markdown");
  $("#fb-csv").onclick = () => download(`${base}-feedback.csv`, toCSV([
    ["Proyecto", "Equipo", ...(names ? ["Juez"] : []), "Feedback"],
    ...items.flatMap((it) => it.fb.map((f) => [it.p.name, it.p.team || "", ...(names ? [f.j.name] : []), f.t])),
  ]), "text/csv");
  $("#fb-print").onclick = () => {
    const w = window.open("", "_blank");
    if (!w) return toast("Permite las ventanas emergentes para imprimir", "error");
    w.document.write(`<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Feedback · ${esc(S.ev.name)}</title>
      <style>body{font:15px/1.55 system-ui,sans-serif;max-width:720px;margin:32px auto;padding:0 16px;color:#111}
      section{page-break-after:always;padding-bottom:24px}h1{font-size:14px;color:#666;font-weight:500;margin:0}
      h2{margin:4px 0 2px}.team{color:#555;margin:0 0 16px}li{margin-bottom:10px;white-space:pre-wrap}</style></head><body>
      ${items.map((it) => `<section><h1>${esc(S.ev.name)}</h1><h2>${esc(it.p.name)}</h2>
        ${it.p.team ? `<p class="team">${esc(it.p.team)}</p>` : ""}
        ${it.fb.length ? `<ul>${it.fb.map((f) => `<li>${esc(fbLine(f, names))}</li>`).join("")}</ul>` : "<p><i>Sin comentarios.</i></p>"}
      </section>`).join("")}
      </body></html>`);
    w.document.close();
    w.focus();
    w.print();
  };
}

/* ---------- Configuración ---------- */

function tabConfig(el) {
  const e = S.ev;
  const crit = structuredClone(e.criteria || []);
  const hasScores = S.judges.some((j) => Object.keys(S.scores[j.id] || {}).length);
  el.innerHTML = `
    <form id="cfg" class="card stack">
      <div class="row between wrap">
        <h3>Configuración del evento</h3>
        <button type="button" class="btn sm" id="export-md" title="Incluye criterios, jueces y proyectos; sirve para duplicar el evento">Exportar .md</button>
      </div>
      <label>Nombre del evento<input name="name" required value="${esc(e.name)}"></label>
      <label>Instrucciones para los jueces<textarea name="description" rows="3">${esc(e.description || "")}</textarea></label>
      <label>Puntaje máximo por criterio (0 a…)<input name="scaleMax" type="number" min="1" max="100" required value="${e.scaleMax || 10}"></label>
      <label class="check"><input type="checkbox" name="open" ${e.open ? "checked" : ""}> Evento abierto (los jueces pueden agregar y calificar proyectos)</label>
      <div>
        <h3>Criterios</h3>
        <p class="muted small">El peso define cuánto cuenta cada criterio en el total (ej. 2 cuenta el doble que 1).
        ${hasScores ? `<br><b>Ya hay calificaciones:</b> si agregas un criterio, esas evaluaciones quedarán incompletas hasta que los jueces lo califiquen.` : ""}</p>
      </div>
      <div id="crit-list" class="stack"></div>
      <div><button type="button" class="btn sm" id="add-c">+ Agregar criterio</button></div>
      <div class="row end"><button class="btn primary">Guardar cambios</button></div>
    </form>
    <div class="card danger-zone stack">
      <h3>Zona de peligro</h3>
      <p class="muted small">Elimina el evento con todos sus proyectos, jueces y calificaciones.</p>
      <div><button class="btn danger" id="del-ev">Eliminar evento</button></div>
    </div>`;

  $("#export-md").onclick = () => download(`${fileSafe(e.name)}.md`, eventToMd(e, S.judges, S.projects), "text/markdown");
  const list = $("#crit-list");
  const draw = () => {
    list.innerHTML = crit.map((c, i) => `<div class="crit-row" data-i="${i}">
      <input data-f="name" placeholder="Nombre del criterio" required value="${esc(c.name)}">
      <input data-f="description" placeholder="Descripción (opcional)" value="${esc(c.description || "")}">
      <label class="weight">Peso <input data-f="weight" type="number" min="0" step="0.1" value="${c.weight ?? 1}"></label>
      <button type="button" class="btn ghost sm danger" data-rm="${i}" title="Quitar">✕</button>
    </div>`).join("") || `<p class="muted">Agrega al menos un criterio.</p>`;
  };
  draw();
  list.oninput = (ev) => {
    const row = ev.target.closest(".crit-row");
    const f = ev.target.dataset.f;
    if (row && f) crit[row.dataset.i][f] = ev.target.value;
  };
  list.onclick = (ev) => {
    const i = ev.target.dataset.rm;
    if (i == null) return;
    crit.splice(Number(i), 1);
    draw();
  };
  $("#add-c").onclick = () => {
    crit.push({ id: randomToken(6), name: "", description: "", weight: 1 });
    draw();
    list.querySelector(".crit-row:last-child input")?.focus();
  };
  $("#cfg").onsubmit = async (ev) => {
    ev.preventDefault();
    if (!crit.length) return toast("Agrega al menos un criterio", "error");
    const fd = new FormData(ev.target);
    const data = {
      name: fd.get("name").trim(),
      description: fd.get("description").trim(),
      scaleMax: Number(fd.get("scaleMax")) || 10,
      open: fd.get("open") === "on",
      criteria: crit.map((c) => ({ id: c.id, name: c.name.trim(), description: (c.description || "").trim(), weight: Number(c.weight) || 0 })),
    };
    if (!data.criteria.some((c) => c.weight > 0)) return toast("Al menos un criterio debe tener peso mayor a 0", "error");
    if (hasScores && data.scaleMax !== e.scaleMax) {
      const ok = await confirmDialog("Cambiar escala",
        `Ya hay calificaciones en escala 0–${e.scaleMax}. Si cambias a 0–${data.scaleMax}, los puntajes existentes se interpretarán con la nueva escala.`, "Cambiar de todos modos");
      if (!ok) return;
    }
    Object.assign(S.ev, await api("PATCH", `events/${e.id}`, data));
    syncEventList();
    toast("Cambios guardados");
    renderEvent();
  };
  $("#del-ev").onclick = async () => {
    const v = await formDialog({
      title: "Eliminar evento",
      note: `Esto borra <b>${esc(e.name)}</b>, ${S.projects.length} proyectos, ${S.judges.length} jueces y todas sus calificaciones. Escribe <b>ELIMINAR</b> para confirmar.`,
      fields: [{ name: "c", label: "Confirmación", required: true }],
      submit: "Eliminar evento", danger: true,
    });
    if (v?.c !== "ELIMINAR") return v && toast("Texto de confirmación incorrecto", "error");
    await api("DELETE", `events/${e.id}`);
    S.events = S.events.filter((x) => x.id !== e.id);
    S.eid = null;
    location.hash = "#/";
    toast("Evento eliminado");
  };
}
