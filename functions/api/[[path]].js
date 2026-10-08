// API de la app de jueces. Corre en Cloudflare Pages Functions con una base D1 (binding DB).
// Secrets requeridos: ADMIN_PASSWORD, SESSION_SECRET.

const SESSION_TTL = 12 * 3600; // segundos
const LOGIN_WINDOW = 15 * 60;
const LOGIN_MAX_FAILS = 10;
const MAX_BODY = 64 * 1024;
const COOKIE = "admin_session";

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (status, message) => { throw new HttpError(status, message); };

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });

const now = () => Math.floor(Date.now() / 1000);

/* ---------- Utilidades criptográficas ---------- */

const enc = new TextEncoder();
const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

// 64 símbolos → 6 bits por carácter, sin sesgo. 24 caracteres = 144 bits.
function randomId(n = 24) {
  return [...crypto.getRandomValues(new Uint8Array(n))].map((b) => B64URL[b & 63]).join("");
}

const toB64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

const hmacKey = (secret) =>
  crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);

async function signSession(env) {
  const exp = String(now() + SESSION_TTL);
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(env.SESSION_SECRET), enc.encode(exp));
  return `${exp}.${toB64url(sig)}`;
}

async function verifySession(env, value) {
  const [exp, sig] = String(value || "").split(".");
  if (!/^\d+$/.test(exp || "") || !sig || Number(exp) < now()) return false;
  try {
    // verify() compara en tiempo constante.
    return await crypto.subtle.verify("HMAC", await hmacKey(env.SESSION_SECRET), fromB64url(sig), enc.encode(exp));
  } catch {
    return false;
  }
}

async function passwordMatches(env, given) {
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(String(given ?? ""))),
    crypto.subtle.digest("SHA-256", enc.encode(env.ADMIN_PASSWORD)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

function getCookie(request, name) {
  for (const part of (request.headers.get("cookie") || "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

function sessionCookie(url, value, maxAge) {
  const secure = url.protocol === "https:" ? "; Secure" : "";
  return `${COOKIE}=${value}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

/* ---------- Validación ---------- */

function str(v, max, label, required = false) {
  const s = v == null ? "" : String(v).trim();
  if (required && !s) fail(400, `${label} es obligatorio.`);
  if (s.length > max) fail(400, `${label} es demasiado largo (máx. ${max} caracteres).`);
  return s;
}

function scaleMax(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 100) fail(400, "El puntaje máximo debe ser un entero entre 1 y 100.");
  return n;
}

function criteria(v) {
  if (!Array.isArray(v) || !v.length) fail(400, "Debe haber al menos un criterio.");
  if (v.length > 30) fail(400, "Máximo 30 criterios.");
  const ids = new Set();
  const out = v.map((c) => {
    const id = c?.id && /^[\w-]{1,40}$/.test(c.id) ? c.id : randomId(6);
    if (ids.has(id)) fail(400, "Criterios con id duplicado.");
    ids.add(id);
    const weight = Number(c?.weight);
    if (!Number.isFinite(weight) || weight < 0 || weight > 100) fail(400, "El peso debe estar entre 0 y 100.");
    return {
      id,
      name: str(c?.name, 100, "El nombre del criterio", true),
      description: str(c?.description, 500, "La descripción del criterio"),
      weight,
    };
  });
  if (!out.some((c) => c.weight > 0)) fail(400, "Al menos un criterio debe tener peso mayor a 0.");
  return out;
}

const DEFAULT_CRITERIA = () => [
  { id: randomId(6), name: "Innovación", description: "Originalidad de la idea", weight: 1 },
  { id: randomId(6), name: "Ejecución técnica", description: "Calidad y funcionamiento de lo construido", weight: 1 },
  { id: randomId(6), name: "Impacto", description: "Valor real para los usuarios o el problema", weight: 1 },
  { id: randomId(6), name: "Presentación", description: "Claridad del pitch y la demo", weight: 1 },
];

/* ---------- Mapeo de filas ---------- */

const eventOut = (r) => ({
  id: r.id, name: r.name, description: r.description, scaleMax: r.scale_max,
  open: !!r.open, criteria: JSON.parse(r.criteria), createdAt: r.created_at,
});
const judgeOut = (r) => ({ id: r.token, eventId: r.event_id, name: r.name, createdAt: r.created_at });
const projectOut = (r) => ({
  id: r.id, eventId: r.event_id, name: r.name, team: r.team, description: r.description,
  createdByName: r.created_by_name, createdAt: r.created_at,
});
const scoreOut = (r) => ({
  judgeId: r.judge_token, projectId: r.project_id, eventId: r.event_id, scores: JSON.parse(r.scores),
  feedback: r.feedback, note: r.note, updatedAt: r.updated_at,
});

async function getEvent(env, id) {
  const r = await env.DB.prepare("SELECT * FROM events WHERE id = ?").bind(id).first();
  if (!r) fail(404, "El evento no existe.");
  return eventOut(r);
}

async function getJudge(env, token) {
  const r = await env.DB.prepare("SELECT * FROM judges WHERE token = ?").bind(token).first();
  if (!r) fail(404, "Este enlace de juez no existe o fue eliminado.");
  return judgeOut(r);
}

async function insertProject(env, eventId, body, createdByName) {
  const p = {
    id: randomId(16), eventId,
    name: str(body.name, 200, "El nombre del proyecto", true),
    team: str(body.team, 300, "El equipo"),
    description: str(body.description, 2000, "La descripción"),
    createdByName, createdAt: now(),
  };
  await env.DB.prepare(
    "INSERT INTO projects (id, event_id, name, team, description, created_by_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).bind(p.id, eventId, p.name, p.team, p.description, createdByName, p.createdAt).run();
  return p;
}

/* ---------- Rutas: sesión del organizador ---------- */

async function login({ env, request, body, url }) {
  const ip = request.headers.get("cf-connecting-ip") || "local";
  const t = now();
  const row = await env.DB.prepare("SELECT count, window_start FROM login_attempts WHERE ip = ?").bind(ip).first();
  if (row && row.window_start > t - LOGIN_WINDOW && row.count >= LOGIN_MAX_FAILS) {
    fail(429, "Demasiados intentos. Espera 15 minutos.");
  }
  if (!(await passwordMatches(env, body.password))) {
    await env.DB.prepare(
      `INSERT INTO login_attempts (ip, count, window_start) VALUES (?1, 1, ?2)
       ON CONFLICT(ip) DO UPDATE SET
         count = CASE WHEN window_start <= ?3 THEN 1 ELSE count + 1 END,
         window_start = CASE WHEN window_start <= ?3 THEN ?2 ELSE window_start END`,
    ).bind(ip, t, t - LOGIN_WINDOW).run();
    fail(401, "Contraseña incorrecta.");
  }
  await env.DB.prepare("DELETE FROM login_attempts WHERE ip = ?").bind(ip).run();
  return json({ ok: true }, 200, { "set-cookie": sessionCookie(url, await signSession(env), SESSION_TTL) });
}

const logout = ({ url }) => json({ ok: true }, 200, { "set-cookie": sessionCookie(url, "", 0) });

/* ---------- Rutas: organizador ---------- */

async function listEvents({ env }) {
  const { results } = await env.DB.prepare("SELECT * FROM events ORDER BY created_at DESC").all();
  return json(results.map(eventOut));
}

async function createEvent({ env, body }) {
  const e = {
    id: randomId(16),
    name: str(body.name, 200, "El nombre del evento", true),
    description: str(body.description, 5000, "La descripción"),
    scaleMax: body.scaleMax == null ? 10 : scaleMax(body.scaleMax),
    open: true,
    criteria: body.criteria == null ? DEFAULT_CRITERIA() : criteria(body.criteria),
    createdAt: now(),
  };
  await env.DB.prepare(
    "INSERT INTO events (id, name, description, scale_max, open, criteria, created_at) VALUES (?, ?, ?, ?, 1, ?, ?)",
  ).bind(e.id, e.name, e.description, e.scaleMax, JSON.stringify(e.criteria), e.createdAt).run();
  return json(e, 201);
}

async function eventBundle({ env, params }) {
  const event = await getEvent(env, params.id);
  const [j, p, s] = await env.DB.batch([
    env.DB.prepare("SELECT * FROM judges WHERE event_id = ?").bind(event.id),
    env.DB.prepare("SELECT * FROM projects WHERE event_id = ?").bind(event.id),
    env.DB.prepare("SELECT * FROM scores WHERE event_id = ?").bind(event.id),
  ]);
  return json({
    event,
    judges: j.results.map(judgeOut),
    projects: p.results.map(projectOut),
    scores: s.results.map(scoreOut),
  });
}

async function updateEvent({ env, params, body }) {
  const e = await getEvent(env, params.id);
  if ("name" in body) e.name = str(body.name, 200, "El nombre del evento", true);
  if ("description" in body) e.description = str(body.description, 5000, "La descripción");
  if ("scaleMax" in body) e.scaleMax = scaleMax(body.scaleMax);
  if ("open" in body) e.open = !!body.open;
  if ("criteria" in body) e.criteria = criteria(body.criteria);
  await env.DB.prepare("UPDATE events SET name = ?, description = ?, scale_max = ?, open = ?, criteria = ? WHERE id = ?")
    .bind(e.name, e.description, e.scaleMax, e.open ? 1 : 0, JSON.stringify(e.criteria), e.id).run();
  return json(e);
}

async function deleteEvent({ env, params }) {
  const id = params.id;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM scores WHERE event_id = ?").bind(id),
    env.DB.prepare("DELETE FROM judges WHERE event_id = ?").bind(id),
    env.DB.prepare("DELETE FROM projects WHERE event_id = ?").bind(id),
    env.DB.prepare("DELETE FROM events WHERE id = ?").bind(id),
  ]);
  return json({ ok: true });
}

async function adminCreateProject({ env, params, body }) {
  await getEvent(env, params.id);
  return json(await insertProject(env, params.id, body, "Organizador"), 201);
}

async function updateProject({ env, params, body }) {
  const r = await env.DB.prepare("SELECT * FROM projects WHERE id = ?").bind(params.id).first();
  if (!r) fail(404, "El proyecto no existe.");
  const p = projectOut(r);
  if ("name" in body) p.name = str(body.name, 200, "El nombre del proyecto", true);
  if ("team" in body) p.team = str(body.team, 300, "El equipo");
  if ("description" in body) p.description = str(body.description, 2000, "La descripción");
  await env.DB.prepare("UPDATE projects SET name = ?, team = ?, description = ? WHERE id = ?")
    .bind(p.name, p.team, p.description, p.id).run();
  return json(p);
}

async function deleteProject({ env, params }) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM scores WHERE project_id = ?").bind(params.id),
    env.DB.prepare("DELETE FROM projects WHERE id = ?").bind(params.id),
  ]);
  return json({ ok: true });
}

async function createJudge({ env, params, body }) {
  await getEvent(env, params.id);
  const j = { id: randomId(24), eventId: params.id, name: str(body.name, 100, "El nombre del juez", true), createdAt: now() };
  await env.DB.prepare("INSERT INTO judges (token, event_id, name, created_at) VALUES (?, ?, ?, ?)")
    .bind(j.id, j.eventId, j.name, j.createdAt).run();
  return json(j, 201);
}

async function updateJudge({ env, params, body }) {
  const j = await getJudge(env, params.token);
  j.name = str(body.name, 100, "El nombre del juez", true);
  await env.DB.prepare("UPDATE judges SET name = ? WHERE token = ?").bind(j.name, j.id).run();
  return json(j);
}

async function deleteJudge({ env, params }) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM scores WHERE judge_token = ?").bind(params.token),
    env.DB.prepare("DELETE FROM judges WHERE token = ?").bind(params.token),
  ]);
  return json({ ok: true });
}

/* ---------- Rutas: juez (autenticado por el token de su enlace) ---------- */

async function judgeBundle({ env, params }) {
  const judge = await getJudge(env, params.token);
  const event = await getEvent(env, judge.eventId);
  const [p, s] = await env.DB.batch([
    env.DB.prepare("SELECT * FROM projects WHERE event_id = ?").bind(event.id),
    env.DB.prepare("SELECT * FROM scores WHERE judge_token = ?").bind(judge.id),
  ]);
  return json({
    judge: { name: judge.name },
    event,
    projects: p.results.map(projectOut),
    scores: s.results.map((r) => {
      const { judgeId, ...score } = scoreOut(r);
      return score;
    }),
  });
}

async function judgeCreateProject({ env, params, body }) {
  const judge = await getJudge(env, params.token);
  const event = await getEvent(env, judge.eventId);
  if (!event.open) fail(403, "El evento está cerrado.");
  return json(await insertProject(env, event.id, body, judge.name), 201);
}

async function judgeSaveScore({ env, params, body }) {
  const judge = await getJudge(env, params.token);
  const event = await getEvent(env, judge.eventId);
  if (!event.open) fail(403, "El evento está cerrado.");
  const project = await env.DB.prepare("SELECT id FROM projects WHERE id = ? AND event_id = ?")
    .bind(params.projectId, event.id).first();
  if (!project) fail(404, "El proyecto no existe en este evento.");

  const given = body.scores && typeof body.scores === "object" ? body.scores : {};
  const scores = {};
  for (const c of event.criteria) {
    const v = given[c.id];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > event.scaleMax) {
      fail(400, `"${c.name}" debe tener un puntaje entre 0 y ${event.scaleMax}.`);
    }
    scores[c.id] = v;
  }
  const s = {
    projectId: project.id, eventId: event.id, scores,
    feedback: str(body.feedback, 5000, "El feedback"),
    note: str(body.note, 2000, "La nota privada"),
    updatedAt: now(),
  };
  await env.DB.prepare(
    `INSERT INTO scores (judge_token, project_id, event_id, scores, feedback, note, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
     ON CONFLICT(judge_token, project_id) DO UPDATE SET
       scores = ?4, feedback = ?5, note = ?6, updated_at = ?7`,
  ).bind(judge.id, s.projectId, s.eventId, JSON.stringify(scores), s.feedback, s.note, s.updatedAt).run();
  return json(s);
}

/* ---------- Router ---------- */

// [método, patrón, handler, requiere organizador]
const ROUTES = [
  ["POST", "login", login, false],
  ["POST", "logout", logout, false],
  ["GET", "me", () => json({ ok: true }), true],
  ["GET", "events", listEvents, true],
  ["POST", "events", createEvent, true],
  ["GET", "events/:id", eventBundle, true],
  ["PATCH", "events/:id", updateEvent, true],
  ["DELETE", "events/:id", deleteEvent, true],
  ["POST", "events/:id/projects", adminCreateProject, true],
  ["PATCH", "projects/:id", updateProject, true],
  ["DELETE", "projects/:id", deleteProject, true],
  ["POST", "events/:id/judges", createJudge, true],
  ["PATCH", "judges/:token", updateJudge, true],
  ["DELETE", "judges/:token", deleteJudge, true],
  ["GET", "j/:token", judgeBundle, false],
  ["POST", "j/:token/projects", judgeCreateProject, false],
  ["PUT", "j/:token/scores/:projectId", judgeSaveScore, false],
].map(([method, pattern, handler, admin]) => [method, pattern.split("/"), handler, admin]);

function match(parts, pattern) {
  if (parts.length !== pattern.length) return null;
  const params = {};
  for (let i = 0; i < parts.length; i++) {
    if (pattern[i].startsWith(":")) params[pattern[i].slice(1)] = parts[i];
    else if (pattern[i] !== parts[i]) return null;
  }
  return params;
}

async function readBody(request) {
  if (request.method === "GET" || request.method === "DELETE") return {};
  // Exigir JSON obliga a los navegadores a hacer preflight CORS en peticiones de otros sitios (que no respondemos).
  if (!(request.headers.get("content-type") || "").startsWith("application/json")) fail(415, "Se esperaba JSON.");
  const text = await request.text();
  if (text.length > MAX_BODY) fail(413, "La solicitud es demasiado grande.");
  try {
    const body = text ? JSON.parse(text) : {};
    if (!body || typeof body !== "object" || Array.isArray(body)) throw 0;
    return body;
  } catch {
    fail(400, "JSON inválido.");
  }
}

export async function onRequest({ request, env }) {
  try {
    if (!env.DB) fail(500, "Falta configurar la base de datos D1 (binding DB).");
    if (!env.ADMIN_PASSWORD || !env.SESSION_SECRET) fail(500, "Faltan los secrets ADMIN_PASSWORD y SESSION_SECRET.");

    const url = new URL(request.url);
    if (request.method !== "GET") {
      const origin = request.headers.get("origin");
      if (origin && origin !== url.origin) fail(403, "Origen no permitido.");
    }

    let parts;
    try {
      parts = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
    } catch {
      fail(400, "Ruta inválida.");
    }

    let pathMatched = false;
    for (const [method, pattern, handler, admin] of ROUTES) {
      const params = match(parts, pattern);
      if (!params) continue;
      pathMatched = true;
      if (method !== request.method) continue;
      if (admin && !(await verifySession(env, getCookie(request, COOKIE)))) fail(401, "Inicia sesión como organizador.");
      const body = await readBody(request);
      return await handler({ request, env, url, params, body });
    }
    fail(pathMatched ? 405 : 404, pathMatched ? "Método no permitido." : "Ruta no encontrada.");
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error(e);
    return json({ error: "Error interno del servidor." }, 500);
  }
}
