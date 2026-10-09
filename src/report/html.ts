import type { FieldAudit } from "../agents/auditor.js";
import type { FieldSpec, FieldValue, OrganizeResult, Quote } from "../types.js";
import { isEmptyValue } from "../util/path.js";

/**
 * 정리 결과를 한 장짜리 HTML 보고서로.
 *
 * 칸마다 [값 · 감사 상태 · 원문 근거(원문 위치에 하이라이트)]를 나란히 보여 준다.
 * "각 칸에 맞는 정보가 들어갔는가"를 사람이 눈으로 확인하는 화면이다.
 * Colab 출력창, 터미널(--html), 서버 응답이 모두 이 함수 하나를 쓴다.
 */

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const STATUS: Record<FieldAudit["status"], [string, string]> = {
  ok: ["확인됨", "ok"],
  fixed: ["감사관이 고침", "fix"],
  moved: ["다른 칸으로 옮김", "fix"],
  cleared: ["근거 없어 비움", "fix"],
  filled: ["감사관이 채움", "fix"],
  flagged: ["확인 필요", "warn"],
  empty: ["비어 있음", "empty"],
};

function fmt(v: unknown): string {
  if (isEmptyValue(v)) return "";
  if (Array.isArray(v)) return v.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(", ");
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("start" in o || "end" in o) return `${o.start ?? "?"} ~ ${o.ongoing ? "진행 중" : (o.end ?? "?")}`;
    return JSON.stringify(o);
  }
  return String(v);
}

function quotesFor(prov: FieldValue[], path: string): Quote[] {
  return prov
    .filter((p) => p.path === path || p.path.startsWith(`${path}.`))
    .flatMap((p) => p.quotes);
}

function evidenceHtml(quotes: Quote[], sources: Map<string, { name: string; text: string }>): string {
  if (!quotes.length) return `<div class="ev none">근거 인용 없음</div>`;
  return quotes.slice(0, 3).map((q) => {
    const src = sources.get(q.sourceId);
    const score = q.alignScore !== undefined ? `<span class="sc">일치 ${Math.round(q.alignScore * 100)}%</span>` : "";
    if (src && q.start !== undefined && q.end !== undefined) {
      const a = Math.max(0, q.start - 70);
      const b = Math.min(src.text.length, q.end + 70);
      return `<div class="ev">${score}<span class="src">${esc(src.name)} · ${q.start}~${q.end}자</span>`
        + `<p>${a > 0 ? "…" : ""}${esc(src.text.slice(a, q.start))}<mark>${esc(src.text.slice(q.start, q.end))}</mark>`
        + `${esc(src.text.slice(q.end, b))}${b < src.text.length ? "…" : ""}</p></div>`;
    }
    return `<div class="ev">${score}<span class="src">원문 위치를 찾지 못함</span><p>${esc(q.text)}</p></div>`;
  }).join("");
}

export function renderReport(r: OrganizeResult): string {
  const audits = new Map((r.audit?.fields ?? []).map((f) => [f.path, f]));
  const sources = new Map((r.sources ?? []).map((s) => [s.sourceId, s]));
  const values = r.form.values as Record<string, unknown>;

  const fieldRow = (label: string, path: string, value: unknown) => {
    const a = audits.get(path);
    const [stLabel, stClass] = STATUS[a?.status ?? (isEmptyValue(value) ? "empty" : "ok")];
    if (isEmptyValue(value) && (!a || a.status === "empty")) return "";
    const notes = (a?.notes ?? []).map((n) => `<li>${esc(n)}</li>`).join("");
    return `<div class="row ${stClass}">
      <div class="lab">${esc(label)}<span class="chip ${stClass}">${stLabel}</span></div>
      <div class="val">${esc(fmt(value)) || '<span class="muted">(비어 있음)</span>'}</div>
      ${evidenceHtml(quotesFor(r.provenance, path), sources)}
      ${notes ? `<ul class="notes">${notes}</ul>` : ""}
    </div>`;
  };

  const renderField = (f: FieldSpec): string => {
    const v = values[f.key];
    if (f.kind !== "repeater") return fieldRow(f.label, f.key, v);
    const rows = Array.isArray(v) ? v : [];
    if (!rows.length) return "";
    return rows.map((row, i) => `<div class="rep"><div class="rephead">${esc(f.label)} ${i + 1}</div>${
      (f.fields ?? []).map((sub) => fieldRow(sub.label, `${f.key}[${i}].${sub.key}`, (row as Record<string, unknown>)?.[sub.key])).join("")
    }</div>`).join("");
  };

  const sections = r.form.layout.map((sec) => {
    const body = sec.fields.map(renderField).join("");
    return body ? `<section><h2>${esc(sec.title)}</h2>${body}</section>` : "";
  }).join("");

  const s = r.audit?.summary;
  const issues = r.review.final.issues.filter((i) => i.severity !== "minor");
  const missing = r.fallback.missing.filter((m) => m.priority !== "low").slice(0, 10);

  return `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ARC 정리 결과 · ${esc(r.typeLabel)}</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--fg:#1c2127;--mut:#68727d;--rule:#dde2e7;--ok:#1e7a4c;--okb:#e3f3ea;--fix:#1f5f8b;--fixb:#e4eef7;--warn:#9a5b00;--warnb:#fbf0dc;--mark:#fff1a8}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.65 "Apple SD Gothic Neo","Malgun Gothic","Noto Sans KR",system-ui,sans-serif}
.wrap{max-width:880px;margin:0 auto;padding:24px 16px 60px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 10px;padding-bottom:6px;border-bottom:2px solid var(--fg)}
.sub{color:var(--mut);font-size:13px}
.tiles{display:flex;flex-wrap:wrap;gap:8px;margin:16px 0}
.tile{background:var(--card);border:1px solid var(--rule);padding:10px 14px;min-width:120px}
.tile b{display:block;font-size:20px;font-variant-numeric:tabular-nums}.tile span{font-size:12px;color:var(--mut)}
.row{background:var(--card);border:1px solid var(--rule);border-left:4px solid var(--rule);padding:10px 14px;margin:8px 0}
.row.ok{border-left-color:var(--ok)}.row.fix{border-left-color:var(--fix)}.row.warn{border-left-color:var(--warn)}
.lab{font-weight:600;font-size:14px;display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.chip{font-size:11px;font-weight:600;padding:1px 8px;border-radius:3px}
.chip.ok{color:var(--ok);background:var(--okb)}.chip.fix{color:var(--fix);background:var(--fixb)}.chip.warn{color:var(--warn);background:var(--warnb)}.chip.empty{color:var(--mut);background:var(--bg)}
.val{margin:4px 0 6px;white-space:pre-wrap;word-break:break-word}
.ev{font-size:13px;color:var(--mut);border-top:1px dashed var(--rule);padding-top:6px;margin-top:6px}
.ev p{margin:2px 0 0;white-space:pre-wrap;word-break:break-word}.ev.none{font-style:italic}
.ev .src{margin-right:8px}.ev .sc{margin-right:8px;font-weight:600}
mark{background:var(--mark);color:var(--fg);padding:0 1px}
.notes{margin:6px 0 0;padding-left:18px;font-size:13px;color:var(--warn)}
.rep{border:1px solid var(--rule);padding:6px 10px 2px;margin:10px 0;background:#fafbfc}
.rephead{font-size:13px;font-weight:600;color:var(--mut)}
.muted{color:var(--mut)}ul.plain{padding-left:18px}
</style></head><body><div class="wrap">
<h1>${esc(r.categoryLabel)} › ${esc(r.typeLabel)}</h1>
<div class="sub">유형 신뢰도 ${Math.round(r.classification.confidence * 100)}% · ${esc(r.classification.rationale.split("\n")[0])}</div>
<div class="tiles">
  ${s ? `<div class="tile"><b>${s.fieldAccuracy}%</b><span>칸 정확도${r.audit?.llm ? "" : " (기계 검증만)"}</span></div>
  <div class="tile"><b>${s.ok}</b><span>확인된 칸</span></div>
  <div class="tile"><b>${s.fixed}</b><span>감사관이 고친 칸</span></div>
  <div class="tile"><b>${s.flagged}</b><span>확인 필요</span></div>` : ""}
  <div class="tile"><b>${r.fallback.completeness}%</b><span>채움률</span></div>
  <div class="tile"><b>$${r.usage.estimatedCostUsd.toFixed(3)}</b><span>추정 비용</span></div>
</div>
${r.audit?.comment ? `<p class="sub">필드 감사관: ${esc(r.audit.comment)}</p>` : ""}
${sections}
${issues.length ? `<h2>남은 문제 ${issues.length}건</h2><ul class="plain">${issues.slice(0, 15).map((i) => `<li>[${esc(i.severity)}] ${esc(i.detail)}</li>`).join("")}</ul>` : ""}
${missing.length ? `<h2>더 채우려면</h2><ul class="plain">${missing.map((m) => `<li><b>${esc(m.label)}</b> — ${esc(m.question)}</li>`).join("")}</ul>` : ""}
${r.audit?.rejected.length ? `<h2>적용하지 않은 감사관 수정 ${r.audit.rejected.length}건</h2><ul class="plain">${r.audit.rejected.map((p) => `<li>${esc(p.path)} (${esc(p.verdict)}) — ${esc(p.why)}</li>`).join("")}</ul>` : ""}
</div></body></html>`;
}
