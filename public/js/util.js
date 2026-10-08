const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

export const fmt = (n, d = 1) => (n == null || Number.isNaN(n) ? "—" : n.toFixed(d));

export const byName = (a, b) => (a.name || "").localeCompare(b.name || "", "es", { sensitivity: "base" });

export const norm = (s) => String(s || "").trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
export function randomToken(n = 24) {
  return [...crypto.getRandomValues(new Uint8Array(n))].map((x) => ALPHABET[x % ALPHABET.length]).join("");
}

// Total ponderado de UNA evaluación en escala 0–100. null si falta algún criterio.
export function judgeTotal(event, score) {
  if (!score?.scores) return null;
  let wSum = 0, acc = 0;
  for (const c of event.criteria || []) {
    const v = score.scores[c.id];
    if (typeof v !== "number") return null;
    const w = Number(c.weight) || 0;
    wSum += w;
    acc += (v / (event.scaleMax || 10)) * w;
  }
  return wSum ? (acc / wSum) * 100 : null;
}

export function toCSV(rows) {
  const cell = (v) => {
    const s = String(v ?? "");
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return "﻿" + rows.map((r) => r.map(cell).join(",")).join("\n");
}

export function download(filename, text, mime = "text/plain") {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export const fileSafe = (s) => norm(s).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "evento";

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const t = document.createElement("textarea");
    t.value = text;
    document.body.append(t);
    t.select();
    document.execCommand("copy");
    t.remove();
  }
  toast("Copiado");
}

export function toast(msg, kind = "ok") {
  let box = document.getElementById("toasts");
  if (!box) {
    box = document.createElement("div");
    box.id = "toasts";
    document.body.append(box);
  }
  const t = document.createElement("div");
  t.className = `toast ${kind}`;
  t.textContent = msg;
  box.append(t);
  setTimeout(() => t.remove(), kind === "error" ? 6000 : 2500);
}

// Diálogo modal con formulario. Resuelve con {campo: valor} o null si se cancela.
export function formDialog({ title, fields = [], submit = "Guardar", note = "", danger = false }) {
  return new Promise((resolve) => {
    const d = document.createElement("dialog");
    d.innerHTML = `<form class="stack">
      <h3>${esc(title)}</h3>
      ${note ? `<p class="muted">${note}</p>` : ""}
      ${fields.map((f) => `<label>${esc(f.label)}${
        f.type === "textarea"
          ? `<textarea name="${f.name}" rows="3" ${f.required ? "required" : ""}>${esc(f.value ?? "")}</textarea>`
          : `<input name="${f.name}" type="${f.type || "text"}" ${f.required ? "required" : ""} value="${esc(f.value ?? "")}">`
      }</label>`).join("")}
      <div class="row end">
        <button type="button" class="btn ghost" data-cancel>Cancelar</button>
        <button class="btn ${danger ? "danger" : "primary"}">${esc(submit)}</button>
      </div>
    </form>`;
    document.body.append(d);
    const form = d.querySelector("form");
    let result = null;
    form.onsubmit = (ev) => {
      ev.preventDefault();
      result = Object.fromEntries([...new FormData(form)].map(([k, v]) => [k, String(v).trim()]));
      d.close();
    };
    d.querySelector("[data-cancel]").onclick = () => d.close();
    d.onclose = () => { d.remove(); resolve(result); };
    d.showModal();
    form.querySelector("input, textarea")?.focus();
  });
}

export const confirmDialog = (title, note, submit = "Confirmar", danger = true) =>
  formDialog({ title, note, submit, danger }).then((r) => r !== null);
