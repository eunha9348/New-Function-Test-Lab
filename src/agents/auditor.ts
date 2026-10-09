import { PIPELINE } from "../config.js";
import {
  ROLE_CONTRACTS, allFieldsFor, labelForPath, roleLegend, roleOf, type FieldRole,
} from "../schema/index.js";
import { SourceIndex } from "../ragkor/index.js";
import { alignQuote, foldWithMap, type FoldedText } from "../ragkor/align.js";
import type { LlmSession } from "../llm/index.js";
import type {
  ExperienceTypeSpec, ExtractedDoc, ExtractionResult, FieldSpec, FieldValue, ReviewIssue,
} from "../types.js";
import { getByPath, isEmptyValue, setByPath } from "../util/path.js";
import { cueRoles, sectionAt, segmentSections, sentenceAround, type TextRole } from "../validate/context.js";
import { rolesIn } from "./extractor.js";

/**
 * 최종 필드 감사관 (sub-agent) — "각 칸에 그 칸의 정보가 들어갔는가".
 *
 * 배분·감독을 거친 최종 결과를 **칸 단위로** 다시 본다. 감독이 '문서 전체'를 심사한다면
 * 감사관은 '칸 하나하나'를 심사한다. 판정은 다섯 가지다.
 *   correct      맞다
 *   wrong_field  내용은 원문에 있지만 다른 칸의 것이다 → moveTo 로 옮긴다
 *   distorted    칸은 맞지만 원문과 다르게 썼다(과장·주어 왜곡·수치 오류) → 원문대로 고친다
 *   incomplete   칸은 맞지만 원문에 더 있는 내용을 빠뜨렸다 → 보충한다
 *   unsupported  원문 근거가 없다 → 비운다
 * 비어 있던 칸은 원문에 그 칸에 맞는 구간이 있을 때만 `fill` 판정을 받는다.
 *
 * 루프에 빠지지 않게 하는 장치
 *   · LLM 호출은 **딱 1회**. 재작업 지시를 다시 배분 단계로 돌려보내지 않는다.
 *   · 감사관의 수정은 그대로 믿지 않는다. 새 값의 근거 인용이 원문 정렬(RapidFuzz 방식)을
 *     통과하고(일치도 ≥ auditorPatchFloor), 새 수치가 원문값·파생값일 때만 적용한다.
 *   · 적용 후 결정론적 검증을 한 번 더 돌려, 수정한 칸에 새 major 이상이 생기면 되돌린다.
 *     되돌림도 LLM을 부르지 않는다.
 */

export type AuditVerdict = "correct" | "wrong_field" | "distorted" | "incomplete" | "unsupported" | "fill";

export interface FieldAudit {
  path: string;
  label: string;
  role: FieldRole;
  /** ok: 확인됨 · fixed: 고침 · moved: 다른 칸으로 옮김 · cleared: 비움 · filled: 새로 채움 · flagged: 문제가 남음 · empty: 비어 있음 */
  status: "ok" | "fixed" | "moved" | "cleared" | "filled" | "flagged" | "empty";
  /** 근거 인용의 최고 정렬 일치도 (0~1). 근거가 없으면 0 */
  grounding: number;
  notes: string[];
}

export interface AuditPatch {
  path: string;
  verdict: AuditVerdict;
  moveTo?: string | null;
  value?: unknown;
  quote?: string | null;
  reason: string;
}

export interface AuditReport {
  /** LLM 감사를 실제로 돌렸는가 (false면 결정론적 사전 감사만) */
  llm: boolean;
  fields: FieldAudit[];
  applied: AuditPatch[];
  rejected: (AuditPatch & { why: string })[];
  summary: {
    audited: number;
    ok: number;
    fixed: number;
    flagged: number;
    empty: number;
    /** 채워진 칸 중 '확인됨+고침' 비율 (0~100) */
    fieldAccuracy: number;
  };
  comment: string;
}

/* ── 감사 단위 ─────────────────────────────────────────────────── */

interface Unit {
  path: string;
  spec: FieldSpec;
  role: FieldRole;
  value: unknown;
  label: string;
}

/** 감사 단위: 최상위 칸 + 반복 입력의 행별 하위 칸. 기간(daterange) 같은 묶음은 한 단위. */
export function auditUnits(type: ExperienceTypeSpec, values: Record<string, unknown>): Unit[] {
  const out: Unit[] = [];
  for (const f of allFieldsFor(type)) {
    const v = values[f.key];
    if (f.kind === "repeater") {
      const rows = Array.isArray(v) ? v : [];
      rows.forEach((row, i) => {
        for (const sub of f.fields ?? []) {
          const path = `${f.key}[${i}].${sub.key}`;
          out.push({ path, spec: sub, role: roleOf(sub), value: (row as Record<string, unknown>)?.[sub.key], label: labelForPath(type, path) });
        }
      });
      continue;
    }
    out.push({ path: f.key, spec: f, role: roleOf(f), value: v, label: f.label });
  }
  return out;
}

function provFor(prov: FieldValue[], path: string): FieldValue[] {
  return prov.filter((p) => p.path === path || p.path.startsWith(`${path}.`) || p.path.startsWith(`${path}[`));
}

/** 경로가 이 유형의 스키마에 있는 칸인가 (반복 입력 행 포함) */
export function isSchemaPath(type: ExperienceTypeSpec, path: string): FieldSpec | null {
  let fields: readonly FieldSpec[] = allFieldsFor(type);
  let spec: FieldSpec | null = null;
  for (const raw of path.split(".")) {
    const m = /^([^[]+)(?:\[(\d+)\])?$/.exec(raw);
    if (!m) return null;
    spec = fields.find((x) => x.key === m[1]) ?? null;
    if (!spec) return null;
    if ((m[2] !== undefined) !== (spec.kind === "repeater")) {
      if (spec.kind === "repeater") return null;   // 반복 입력은 행 번호가 있어야 한다
      if (m[2] !== undefined) return null;
    }
    fields = spec.fields ?? [];
  }
  return spec;
}

/* ── 결정론적 사전 감사 ───────────────────────────────────────── */

interface PreAudit {
  units: Unit[];
  audits: Map<string, FieldAudit>;
  evidence: Map<string, string>;         // path → 원문 근거 문장 (앞뒤 포함)
  candidates: Map<string, string>;       // 빈 칸 path → 그 칸에 맞아 보이는 원문 구간
}

/** 중복 배치를 따질 서술형 역할 — 명칭·날짜처럼 한 줄을 나눠 쓰는 칸은 제외 */
const NARRATIVE = new Set<FieldRole>(["outcome", "action", "reflection", "background", "issue"]);

const ROLE_TO_TEXT: Partial<Record<FieldRole, TextRole[]>> = {
  outcome: ["outcome"],
  reflection: ["reflection", "limitation", "plan"],
  background: ["background"],
  team: ["team"],
  action: ["action"],
};

export function preAudit(
  type: ExperienceTypeSpec,
  draft: ExtractionResult,
  docs: ExtractedDoc[],
  issues: ReviewIssue[],
): PreAudit {
  const units = auditUnits(type, draft.values);
  const audits = new Map<string, FieldAudit>();
  const evidence = new Map<string, string>();
  const candidates = new Map<string, string>();
  const sections = new Map(docs.map((d) => [d.sourceId, segmentSections(d.text)]));

  // 같은 원문 구간이 역할이 같은 여러 칸의 근거로 쓰였는가 (중복 배치).
  // 역할이 다른 칸이 한 문장을 나눠 쓰는 것은 정상이다('~를 적용해 210ms로 줄였다' → 내가 한 일 + 성과).
  const spanOwners: { path: string; role: FieldRole; sourceId: string; start: number; end: number }[] = [];

  for (const u of units) {
    const filled = !isEmptyValue(u.value);
    const prov = provFor(draft.provenance, u.path);
    const quotes = prov.flatMap((p) => p.quotes);
    const grounding = quotes.reduce((a, q) => Math.max(a, q.alignScore ?? 0), 0);
    const notes: string[] = [];

    for (const i of issues) {
      if (i.path === u.path || i.path.startsWith(`${u.path}.`) || i.path.startsWith(`${u.path}[`)) {
        if (i.severity !== "minor" || i.type === "context_mismatch") notes.push(`[${i.severity}/${i.type}] ${i.detail}`);
      }
    }

    if (filled) {
      const sentences: string[] = [];
      for (const q of quotes) {
        const doc = docs.find((d) => d.sourceId === q.sourceId);
        if (!doc || q.start === undefined || q.end === undefined) continue;
        const sec = sectionAt(sections.get(doc.sourceId) ?? [], q.start);
        sentences.push(`${sec?.title ? `〔${sec.title}〕 ` : ""}${sentenceAround(doc.text, q.start, q.end).slice(0, 300)}`);
        spanOwners.push({ path: u.path, role: u.role, sourceId: q.sourceId, start: q.start, end: q.end });
      }
      if (sentences.length) evidence.set(u.path, [...new Set(sentences)].slice(0, 3).join(" / "));
      const textual = typeof u.value === "string" && u.value.trim().length > 12;
      if (!quotes.length && textual && u.role !== "choice" && u.role !== "file") notes.push("근거 인용이 없습니다.");
      else if (quotes.length && grounding < PIPELINE.auditorPatchFloor) notes.push(`근거 일치도가 낮습니다 (${Math.round(grounding * 100)}%).`);
    } else {
      // 빈 칸인데 원문에 그 칸 역할의 섹션이 있으면 후보로 넘긴다 (과소 추출 방지)
      const want = ROLE_TO_TEXT[u.role];
      if (want && !u.path.includes("[")) {
        for (const d of docs) {
          for (const s of sections.get(d.sourceId) ?? []) {
            if (!s.title) continue;
            const c = cueRoles(s.title);
            if (want.some((r) => c[r] > 0) && c.outcome + c.limitation + c.plan + c.reflection + c.background + c.team + c.action > 0) {
              const body = d.text.slice(s.start, s.end).trim();
              if (body.length > s.title.length + 10) {
                candidates.set(u.path, body.slice(0, 500));
                break;
              }
            }
          }
          if (candidates.has(u.path)) break;
        }
      }
    }

    audits.set(u.path, {
      path: u.path, label: u.label, role: u.role,
      status: filled ? (notes.length ? "flagged" : "ok") : "empty",
      grounding: Math.round(grounding * 1000) / 1000, notes,
    });
  }

  for (let i = 0; i < spanOwners.length; i++) {
    for (let j = i + 1; j < spanOwners.length; j++) {
      const a = spanOwners[i]!, b = spanOwners[j]!;
      if (a.sourceId !== b.sourceId || a.path === b.path || a.role !== b.role || !NARRATIVE.has(a.role)) continue;
      if (a.path.split("[")[0] === b.path.split("[")[0]) continue;     // 같은 반복 입력 안은 허용
      const ov = Math.min(a.end, b.end) - Math.max(a.start, b.start);
      if (ov > 0.8 * Math.min(a.end - a.start, b.end - b.start)) {
        for (const p of [a.path, b.path]) {
          const au = audits.get(p)!;
          const other = p === a.path ? b.path : a.path;
          const note = `같은 원문 문장이 '${audits.get(other)!.label}' 칸에도 쓰였습니다 (중복 배치).`;
          if (!au.notes.includes(note)) au.notes.push(note);
          if (au.status === "ok") au.status = "flagged";
        }
      }
    }
  }

  return { units, audits, evidence, candidates };
}

/* ── LLM 감사 ─────────────────────────────────────────────────── */

const SYSTEM = `당신은 ARC 경험 기록 서비스의 **최종 필드 감사관**이다.
앞 단계(배분·감독)가 끝난 결과를 **칸 하나씩** 원문과 대조해 판정한다.
이 서비스에서 가장 중요한 것은 "각 칸에 그 칸에 맞는 정보가 정확히 들어갔는가"다.

── 판정 (칸마다 하나) ──
· correct      원문에 근거가 있고, 그 칸의 역할에 맞고, 원문 의미 그대로다.
· wrong_field  내용은 원문에 있지만 다른 칸의 것이다. moveTo에 옮길 칸의 경로를 쓴다.
               (예: 한계 문장이 '핵심 성과'에 → 회고 칸, 팀이 한 일이 '내 역할'에 → 팀 구성 칸)
· distorted    칸은 맞지만 원문과 다르게 썼다 — 과장(참여→주도), 주어 왜곡(팀→나), 수치·이름 오류.
               valueJson에 원문대로 고친 값을 쓴다.
· incomplete   칸은 맞지만 원문에 그 칸에 들어갈 내용이 더 있다(특히 성과 수치, 반복 입력의 빠진 건).
               valueJson에 보충한 값을 쓴다.
· unsupported  원문에서 근거를 찾을 수 없다. 값은 비운다.
· fill         비어 있는 칸인데 원문(아래 '빈 칸 후보 구간')에 그 칸에 맞는 내용이 분명히 있다.

── 규칙 ──
1. 고치거나 채울 때는 quote에 그 값의 근거가 되는 원문 문장을 **글자 그대로** 복사한다.
   quote가 원문과 다르면 수정은 기계 검증에서 버려진다. 확신이 없으면 correct 또는 unsupported.
2. 원문에 없는 수치·이름·날짜를 만들지 않는다. 원문 수치에서 계산한 값(차이·비율)만 허용.
3. 각 칸 옆 [역할]과 아래 '역할별 계약'을 기준으로 판단한다. 문장이 진짜여도 역할이 다르면 wrong_field.
4. '사전 감사 메모'는 기계가 찾은 단서다. 맞는지 원문으로 확인하고 판단한다. 무조건 따르지 않는다.
5. valueJson은 JSON 인코딩 문자열이다. 예: "\\"백엔드 API 설계\\"", "null".
6. 모든 칸에 판정을 낸다(목록에 있는 칸만). 문제없는 칸도 correct로 적는다.`;

const SCHEMA = {
  type: "object",
  properties: {
    fields: {
      type: "array",
      items: {
        type: "object",
        properties: {
          path: { type: "string" },
          verdict: { type: "string", enum: ["correct", "wrong_field", "distorted", "incomplete", "unsupported", "fill"] },
          moveTo: { type: ["string", "null"] },
          valueJson: { type: ["string", "null"] },
          quote: { type: ["string", "null"] },
          reason: { type: "string", description: "한국어 한 문장. 원문을 근거로." },
        },
        required: ["path", "verdict", "moveTo", "valueJson", "quote", "reason"],
        additionalProperties: false,
      },
    },
    comment: { type: "string", description: "한국어 2~3문장 총평" },
  },
  required: ["fields", "comment"],
  additionalProperties: false,
} as const;

function short(v: unknown, n = 300): string {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

async function askAuditor(
  session: LlmSession,
  type: ExperienceTypeSpec,
  pre: PreAudit,
  evidenceText: string,
): Promise<{ patches: AuditPatch[]; comment: string }> {
  const filled = pre.units.filter((u) => !isEmptyValue(u.value)).slice(0, 60);
  const empties = pre.units.filter((u) => pre.candidates.has(u.path)).slice(0, 10);
  if (!filled.length && !empties.length) return { patches: [], comment: "" };

  const lines = filled.map((u) => {
    const a = pre.audits.get(u.path)!;
    return [
      `■ ${u.path} | ${u.label} [${ROLE_CONTRACTS[u.role].label}]`,
      `  값: ${short(u.value)}`,
      `  근거: ${pre.evidence.get(u.path) ?? "(근거 위치 없음)"}`,
      a.notes.length ? `  사전 감사 메모: ${a.notes.map((n) => short(n, 160)).join(" / ")}` : "",
    ].filter(Boolean).join("\n");
  });
  const emptyLines = empties.map((u) =>
    `□ ${u.path} | ${u.label} [${ROLE_CONTRACTS[u.role].label}] — 비어 있음\n  후보 구간: ${short(pre.candidates.get(u.path), 500)}`);

  const fieldList = allFieldsFor(type)
    .map((f) => `- ${f.key} | ${f.label} [${ROLE_CONTRACTS[roleOf(f)].label}]${f.kind === "repeater" ? ` (반복: ${(f.fields ?? []).map((c) => c.key).join(", ")})` : ""}`)
    .join("\n");

  const raw = await session.structured<{
    fields: { path: string; verdict: AuditVerdict; moveTo: string | null; valueJson: string | null; quote: string | null; reason: string }[];
    comment: string;
  }>({
    stage: "supervise",
    systemStable: [
      SYSTEM, "",
      `── 유형: ${type.emoji} ${type.label} (${type.id}) — 옮길 수 있는 칸 목록 ──`, fieldList, "",
      "── 역할별 계약 ──", roleLegend(rolesIn(type)),
    ].join("\n"),
    toolName: "submit_field_audit",
    toolDescription: "칸별 감사 판정을 제출한다.",
    schema: SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 16000,
    content: [
      { type: "text", text: `## 원문 근거 구간\n${evidenceText}` },
      { type: "text", text: `## 감사할 칸 (채워진 칸)\n${lines.join("\n\n") || "(없음)"}` },
      ...(emptyLines.length ? [{ type: "text" as const, text: `## 빈 칸 후보 구간\n${emptyLines.join("\n\n")}` }] : []),
    ],
  });

  const patches: AuditPatch[] = (raw.fields ?? []).map((f) => {
    let value: unknown;
    if (f.valueJson != null) {
      try {
        value = JSON.parse(f.valueJson);
      } catch {
        value = f.valueJson;
      }
    }
    return { path: f.path, verdict: f.verdict, moveTo: f.moveTo, value, quote: f.quote, reason: f.reason };
  });
  return { patches, comment: raw.comment ?? "" };
}

/* ── 패치 적용 (기계 검증 통과분만) ───────────────────────────── */

export interface ApplyContext {
  type: ExperienceTypeSpec;
  docs: ExtractedDoc[];
  index: SourceIndex;
  pre: PreAudit;
}

function bestAlignment(quote: string, docs: ExtractedDoc[], folded: Map<string, FoldedText>) {
  let best: { sourceId: string; start: number; end: number; score: number } | null = null;
  for (const d of docs) {
    let f = folded.get(d.sourceId);
    if (!f) folded.set(d.sourceId, (f = foldWithMap(d.text)));
    const r = alignQuote(quote, f);
    if (r && (!best || r.score > best.score)) best = { sourceId: d.sourceId, ...r };
  }
  return best;
}

/** 새 값에 원문에 없는 수치가 있으면 그 수치를 돌려준다 */
function unknownNumbers(value: unknown, index: SourceIndex): string[] {
  const flat = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return [...flat.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*(%p|%|％|퍼센트|포인트)?/g)]
    .filter((m) => m[1]!.replace(/,/g, "").length >= 2
      && index.classifyNumber(m[1]!, { percent: !!m[2] }) === "unknown")
    .map((m) => m[1]!);
}

export function applyAuditPatches(
  draft: ExtractionResult,
  patches: AuditPatch[],
  ctx: ApplyContext,
): { draft: ExtractionResult; applied: AuditPatch[]; rejected: (AuditPatch & { why: string })[] } {
  const values = structuredClone(draft.values);
  let provenance = [...draft.provenance];
  const applied: AuditPatch[] = [];
  const rejected: (AuditPatch & { why: string })[] = [];
  const folded = new Map<string, FoldedText>();
  const reject = (p: AuditPatch, why: string) => rejected.push({ ...p, why });
  const replaceProv = (path: string, quote: { sourceId: string; start: number; end: number; score: number; text: string }) => {
    provenance = provenance.filter((p) => !(p.path === path || p.path.startsWith(`${path}.`)));
    provenance.push({
      path, value: undefined, confidence: Math.min(0.95, quote.score),
      quotes: [{ sourceId: quote.sourceId, text: quote.text, start: quote.start, end: quote.end, alignScore: quote.score }],
    });
  };

  for (const p of patches) {
    if (p.verdict === "correct") continue;
    const unit = ctx.pre.units.find((u) => u.path === p.path);
    if (!unit) { reject(p, "감사 대상에 없는 칸입니다."); continue; }
    const audit = ctx.pre.audits.get(p.path)!;

    if (p.verdict === "unsupported") {
      // 근거가 단단하고 기계 단서도 없는 칸은 감사관 말만 듣고 지우지 않는다
      const hasProblem = audit.notes.length > 0 || audit.grounding < PIPELINE.auditorPatchFloor;
      if (!hasProblem) { reject(p, `근거 일치도 ${Math.round(audit.grounding * 100)}%로 원문에 있는 값이라 지우지 않았습니다.`); continue; }
      setByPath(values, p.path, null);
      provenance = provenance.filter((x) => !(x.path === p.path || x.path.startsWith(`${p.path}.`)));
      applied.push(p);
      continue;
    }

    if (p.verdict === "wrong_field") {
      const to = p.moveTo?.trim();
      const spec = to ? isSchemaPath(ctx.type, to) : null;
      if (!to || !spec || spec.kind === "repeater") { reject(p, `옮길 칸 '${to ?? ""}'이 이 유형에 없습니다.`); continue; }
      if (roleOf(spec) === unit.role) { reject(p, "역할이 같은 칸으로는 옮기지 않습니다."); continue; }
      if (!isEmptyValue(getByPath(values, to))) { reject(p, `'${labelForPath(ctx.type, to)}' 칸이 이미 채워져 있어 옮기지 않았습니다.`); continue; }
      const moving = getByPath(values, p.path);
      setByPath(values, to, spec.kind === "tags" && typeof moving === "string" ? [moving] : moving);
      setByPath(values, p.path, null);
      provenance = provenance.map((x) =>
        x.path === p.path || x.path.startsWith(`${p.path}.`) ? { ...x, path: to + x.path.slice(p.path.length) } : x);
      applied.push(p);
      continue;
    }

    // distorted / incomplete / fill — 새 값은 원문 정렬을 통과해야 한다
    if (p.value === undefined || isEmptyValue(p.value)) { reject(p, "고칠 값이 없습니다."); continue; }
    if (!p.quote) { reject(p, "근거 인용이 없습니다."); continue; }
    const al = bestAlignment(p.quote, ctx.docs, folded);
    if (!al || al.score < PIPELINE.auditorPatchFloor) {
      reject(p, `근거 인용이 원문과 맞지 않습니다 (일치도 ${Math.round((al?.score ?? 0) * 100)}%).`);
      continue;
    }
    const bad = unknownNumbers(p.value, ctx.index);
    if (bad.length) { reject(p, `원문에 없는 수치가 있습니다: ${bad.join(", ")}`); continue; }
    if (unit.spec.options && typeof p.value === "string" && !unit.spec.options.includes(p.value)) {
      reject(p, `보기에 없는 값입니다: ${p.value}`);
      continue;
    }
    setByPath(values, p.path, p.value);
    replaceProv(p.path, { ...al, text: p.quote });
    applied.push(p);
  }

  return { draft: { values, provenance, unfilled: draft.unfilled }, applied, rejected };
}

/* ── 진입점 ───────────────────────────────────────────────────── */

export async function auditFields(
  session: LlmSession,
  type: ExperienceTypeSpec,
  draft: ExtractionResult,
  docs: ExtractedDoc[],
  index: SourceIndex,
  opts: {
    issues: ReviewIssue[];
    evidenceText: string;
    useLlm: boolean;
    /** 패치 적용 후 결정론적 재검증 — 수정한 칸에 새 문제가 생기면 그 수정을 되돌린다 */
    revalidate: (d: ExtractionResult) => Promise<ReviewIssue[]>;
  },
): Promise<{ draft: ExtractionResult; report: AuditReport; issues: ReviewIssue[] }> {
  const pre = preAudit(type, draft, docs, opts.issues);
  let patches: AuditPatch[] = [];
  let comment = "";
  let llm = false;

  if (opts.useLlm) {
    try {
      const r = await askAuditor(session, type, pre, opts.evidenceText);
      patches = r.patches;
      comment = r.comment;
      llm = true;
    } catch (e) {
      comment = `감사관 호출 실패 — 결정론적 사전 감사만 반영했습니다 (${(e as Error).message.slice(0, 120)})`;
    }
  }

  let { draft: next, applied, rejected } = applyAuditPatches(draft, patches, { type, docs, index, pre });

  // 되돌림 검사 — 수정한 칸(또는 옮겨 간 칸)에 새 major 이상이 생겼으면 그 수정만 취소한다
  let issues = applied.length ? await opts.revalidate(next) : opts.issues;
  if (applied.length) {
    const before = new Set(opts.issues.filter((i) => i.severity !== "minor").map((i) => `${i.path}|${i.type}`));
    const touched = (p: AuditPatch) => [p.path, p.moveTo].filter(Boolean) as string[];
    const regress = applied.filter((p) => issues.some((i) =>
      i.severity !== "minor" && !before.has(`${i.path}|${i.type}`)
      && touched(p).some((t) => i.path === t || i.path.startsWith(`${t}.`))));
    if (regress.length) {
      const keep = applied.filter((p) => !regress.includes(p));
      ({ draft: next } = applyAuditPatches(draft, keep, { type, docs, index, pre }));
      for (const p of regress) rejected.push({ ...p, why: "적용하면 새 검증 문제가 생겨 되돌렸습니다." });
      applied = keep;
      issues = keep.length ? await opts.revalidate(next) : opts.issues;
    }
  }

  // 최종 칸별 상태
  const verdictBy = new Map(patches.map((p) => [p.path, p]));
  const appliedBy = new Map(applied.map((p) => [p.path, p]));
  const fields = [...pre.audits.values()].map((a) => {
    const ap = appliedBy.get(a.path);
    const v = verdictBy.get(a.path);
    const notes = [...a.notes];
    if (v && v.verdict !== "correct") notes.push(`감사관: ${v.reason}`);
    const rj = rejected.find((r) => r.path === a.path);
    if (rj) notes.push(`수정 보류: ${rj.why}`);
    let status: FieldAudit["status"] = a.status;
    if (ap) {
      status = ap.verdict === "wrong_field" ? "moved" : ap.verdict === "unsupported" ? "cleared"
        : ap.verdict === "fill" ? "filled" : "fixed";
    } else if (v?.verdict === "correct" && a.status === "flagged") {
      // 감사관이 원문으로 확인했지만 기계 단서가 남은 칸 — 사람이 볼 수 있게 flagged 유지
      status = "flagged";
    } else if (v && v.verdict !== "correct" && a.status !== "empty") {
      status = "flagged";
    }
    return { ...a, status, notes };
  });

  const filledFields = fields.filter((f) => f.status !== "empty");
  const ok = fields.filter((f) => f.status === "ok").length;
  const fixed = fields.filter((f) => ["fixed", "moved", "cleared", "filled"].includes(f.status)).length;
  const flagged = fields.filter((f) => f.status === "flagged").length;

  const auditIssues: ReviewIssue[] = fields
    .filter((f) => f.status === "flagged")
    .map((f) => ({
      severity: "minor" as const,
      type: "misplaced" as const,
      path: f.path,
      detail: `[필드 감사] '${f.label}' 확인 필요: ${f.notes.slice(-2).join(" / ").slice(0, 200)}`,
      foundBy: "auditor" as const,
    }));

  return {
    draft: next,
    issues: [...issues, ...auditIssues],
    report: {
      llm,
      fields,
      applied,
      rejected,
      summary: {
        audited: filledFields.length,
        ok,
        fixed,
        flagged,
        empty: fields.length - filledFields.length,
        fieldAccuracy: filledFields.length ? Math.round(((ok + fixed) / filledFields.length) * 100) : 0,
      },
      comment,
    },
  };
}
