// Formato Markdown para definir un evento completo (importar y exportar).
//
//   # Nombre del evento
//   Instrucciones para los jueces (texto libre)
//   ## Configuración   - escala: 10 / - abierto: sí
//   ## Criterios       - Nombre (peso 2): descripción
//   ## Jueces          - Nombre
//   ## Proyectos       - Nombre | Equipo | Descripción
//
// Criterios, jueces y proyectos también aceptan tablas Markdown.

import { norm } from "./util.js";

const SECTIONS = {
  config: ["configuracion", "config", "ajustes"],
  criteria: ["criterios", "criterios de evaluacion", "rubrica", "evaluacion"],
  judges: ["jueces", "jurado"],
  projects: ["proyectos", "equipos"],
};

const sectionKey = (title) => {
  const t = norm(title.replace(/[*_`]/g, ""));
  return Object.keys(SECTIONS).find((k) => SECTIONS[k].includes(t)) || null;
};

const clean = (s) => String(s || "").replace(/\*\*|__|`/g, "").trim();

// Convierte las líneas de una sección en filas: { item } para listas, { cells, header } para tablas.
function toRows(lines, warnings) {
  const rows = [];
  let header = null;
  for (const { text, n } of lines) {
    let m;
    if (text.startsWith("|")) {
      const cells = text.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => clean(c));
      if (cells.every((c) => /^:?-+:?$/.test(c) || c === "")) continue;
      if (!header) header = cells.map(norm);
      else rows.push({ cells, header, n });
    } else if ((m = text.match(/^(?:[-*+]|\d+[.)])\s+(.*)$/))) {
      rows.push({ item: clean(m[1]), n });
    } else {
      warnings.push(`Línea ${n} ignorada (se esperaba un elemento de lista "- …" o una fila de tabla): "${text}"`);
    }
  }
  return rows;
}

// Valor de la primera columna cuyo encabezado coincida con alguno de los nombres.
function col(row, names, fallbackIndex = -1) {
  let i = row.header.findIndex((h) => names.some((n) => h === n || h.startsWith(n)));
  if (i < 0) i = fallbackIndex;
  return i >= 0 ? (row.cells[i] ?? "") : "";
}

function number(s) {
  const m = String(s).replace(",", ".").match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : NaN;
}

function parseConfig(lines, warnings) {
  const out = {};
  for (const { text, n } of lines) {
    const m = clean(text.replace(/^(?:[-*+]|\d+[.)])\s+/, "")).match(/^([^:]+):\s*(.*)$/);
    if (!m) {
      warnings.push(`Línea ${n}: configuración no reconocida "${text}" (usa "clave: valor").`);
      continue;
    }
    const key = norm(m[1]);
    const val = m[2].trim();
    if (/^(escala|puntaje|maximo|puntaje maximo|escala maxima|nota maxima)/.test(key)) {
      // "10", "0-10", "1 a 10" → el último número
      const nums = val.match(/\d+/g);
      const max = nums ? Number(nums[nums.length - 1]) : NaN;
      if (!Number.isInteger(max) || max < 1 || max > 100) throw new Error(`Línea ${n}: la escala debe ser un entero entre 1 y 100.`);
      out.scaleMax = max;
    } else if (/^(abierto|estado|abierta)/.test(key)) {
      const v = norm(val);
      if (/^(si|true|abierto|abierta|yes|1)$/.test(v)) out.open = true;
      else if (/^(no|false|cerrado|cerrada|0)$/.test(v)) out.open = false;
      else warnings.push(`Línea ${n}: valor "${val}" no reconocido para abierto (usa sí/no).`);
    } else {
      warnings.push(`Línea ${n}: clave de configuración desconocida "${m[1].trim()}".`);
    }
  }
  return out;
}

function parseCriteria(rows) {
  return rows.map((r) => {
    let name, description, weight = 1;
    if (r.item != null) {
      let s = r.item;
      const w = s.match(/\(\s*(?:peso\s*:?\s*|x\s*)?(\d+(?:[.,]\d+)?)\s*%?\s*\)/i);
      if (w) {
        weight = number(w[1]);
        s = s.replace(w[0], " ").replace(/\s+/g, " ").trim();
      }
      const m = s.match(/^(.+?)(?:\s*:\s+|\s*:$|\s+[—–-]\s+)(.*)$/);
      name = (m ? m[1] : s).trim();
      description = m ? m[2].trim() : "";
    } else {
      name = col(r, ["criterio", "nombre"], 0);
      description = col(r, ["descripcion", "detalle", "que se evalua"]);
      const ws = col(r, ["peso", "ponderacion", "valor"]);
      if (ws) weight = number(ws);
    }
    if (!name) throw new Error(`Línea ${r.n}: criterio sin nombre.`);
    if (!Number.isFinite(weight) || weight < 0) throw new Error(`Línea ${r.n}: peso inválido en "${name}".`);
    return { name, description, weight };
  });
}

const parseJudges = (rows) =>
  rows.map((r) => (r.item != null ? r.item : col(r, ["nombre", "juez"], 0))).filter(Boolean);

function parseProjects(rows) {
  return rows.map((r) => {
    if (r.item != null) {
      const [name = "", team = "", ...desc] = r.item.split("|").map((s) => s.trim());
      return { name, team, description: desc.join(" | ") };
    }
    return {
      name: col(r, ["proyecto", "nombre"], 0),
      team: col(r, ["equipo", "integrantes"]),
      description: col(r, ["descripcion", "detalle"]),
    };
  }).filter((p) => p.name);
}

function dedupe(list, keyFn, label, warnings) {
  const seen = new Set();
  return list.filter((x) => {
    const k = norm(keyFn(x));
    if (seen.has(k)) {
      warnings.push(`${label} repetido ignorado: "${keyFn(x)}".`);
      return false;
    }
    seen.add(k);
    return true;
  });
}

/**
 * Lee un .md de evento. Devuelve { event: {name, description, scaleMax?, open?, criteria?, judges, projects}, warnings }.
 * Lanza Error con el número de línea si algo impide crear el evento.
 */
export function parseEventMd(text) {
  // Quita comentarios HTML conservando los saltos de línea (para reportar líneas correctas).
  const src = String(text).replace(/\r\n?/g, "\n").replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, ""));
  const warnings = [];
  const buckets = { config: [], criteria: [], judges: [], projects: [] };
  const desc = [];
  let name = "";
  let section = "description";
  let m;

  src.split("\n").forEach((raw, i) => {
    const line = raw.trimEnd();
    if (!name && section === "description" && (m = line.match(/^#\s+(.+)$/))) {
      name = clean(m[1]);
      return;
    }
    if ((m = line.match(/^##\s+(.+)$/))) {
      const key = sectionKey(m[1]);
      section = key || "description";
      if (!key) desc.push(line); // secciones desconocidas se conservan en las instrucciones
      return;
    }
    if (section === "description") desc.push(line);
    else if (line.trim()) buckets[section].push({ text: line.trim(), n: i + 1 });
  });

  if (!name) throw new Error('Falta el título del evento: la primera línea debe ser "# Nombre del evento".');

  const event = {
    name,
    description: desc.join("\n").replace(/^\s*\n+|\n+\s*$/g, "").replace(/\n{3,}/g, "\n\n"),
    ...parseConfig(buckets.config, warnings),
    judges: [],
    projects: [],
  };

  if (buckets.criteria.length) {
    event.criteria = dedupe(parseCriteria(toRows(buckets.criteria, warnings)), (c) => c.name, "Criterio", warnings);
    if (!event.criteria.length) throw new Error('La sección "Criterios" no tiene criterios válidos.');
    if (!event.criteria.some((c) => c.weight > 0)) throw new Error("Al menos un criterio debe tener peso mayor a 0.");
  } else {
    warnings.push('No hay sección "## Criterios": se usarán los criterios por defecto (Innovación, Ejecución técnica, Impacto, Presentación).');
  }
  event.judges = dedupe(parseJudges(toRows(buckets.judges, warnings)), (j) => j, "Juez", warnings);
  event.projects = dedupe(parseProjects(toRows(buckets.projects, warnings)), (p) => p.name, "Proyecto", warnings);
  if (!event.judges.length) warnings.push("No hay jueces: podrás agregarlos después en la pestaña Jueces.");

  return { event, warnings };
}

const oneLine = (s) => String(s || "").replace(/\s*\n\s*/g, " ").trim();
const noPipe = (s) => oneLine(s).replace(/\|/g, "/");

/** Genera el .md de un evento existente (mismo formato que acepta parseEventMd). */
export function eventToMd(ev, judges = [], projects = []) {
  const out = [`# ${oneLine(ev.name)}`, ""];
  if (ev.description) out.push(ev.description.trim(), "");
  out.push("## Configuración", "", `- escala: ${ev.scaleMax}`, `- abierto: ${ev.open ? "sí" : "no"}`, "");
  out.push("## Criterios", "");
  for (const c of ev.criteria || []) {
    out.push(`- ${oneLine(c.name).replace(/:/g, "")} (peso ${c.weight})${c.description ? `: ${oneLine(c.description)}` : ""}`);
  }
  out.push("", "## Jueces", "");
  for (const j of judges) out.push(`- ${oneLine(j.name)}`);
  out.push("", "## Proyectos", "");
  for (const p of projects) {
    const parts = [noPipe(p.name), noPipe(p.team), noPipe(p.description)];
    while (parts.length > 1 && !parts[parts.length - 1]) parts.pop();
    out.push(`- ${parts.join(" | ")}`);
  }
  return out.join("\n") + "\n";
}
