import { allFieldsFor } from "../schema/index.js";
import { SourceIndex, fold } from "../ragkor/index.js";
import type {
  ExperienceTypeSpec, ExtractionResult, FieldSpec, FieldValue,
} from "../types.js";
import type { LlmSession } from "../llm/index.js";
import { isEmptyValue } from "../util/path.js";

export interface FieldConflict {
  key: string;
  label: string;
  kind: FieldSpec["kind"];
  options: [unknown, unknown];
}

function provFor(prov: FieldValue[], path: string): FieldValue[] {
  return prov.filter((p) => p.path === path || p.path.startsWith(`${path}[`) || p.path.startsWith(`${path}.`));
}

/** 이 값이 '원문에 근거하고 구체적인가'를 점수로. */
function fieldScore(f: FieldSpec, value: unknown, prov: FieldValue[], idx: SourceIndex): number {
  if (isEmptyValue(value)) return -1;
  let score = 0;

  const quotes = provFor(prov, f.key).flatMap((p) => p.quotes);
  if (quotes.length) {
    const gs = quotes.map((q) => idx.verifyQuote(q.text).score);
    score += 2 * (gs.reduce((a, b) => a + b, 0) / gs.length);
  } else {
    score += 0.8;                                   // 근거 미제출은 중간 취급
  }

  const flat = JSON.stringify(value);
  const nums = flat.match(/\d[\d,]*(?:\.\d+)?/g) ?? [];
  const good = nums.filter((n) => idx.classifyNumber(n) !== "unknown").length;
  score += Math.min(0.8, 0.2 * good) - 1.2 * (nums.length - good); // 근거 없는 숫자는 강하게 감점

  if (f.kind === "repeater" && Array.isArray(value)) {
    const filled = value.filter(
      (row) => row && typeof row === "object"
        && Object.values(row as Record<string, unknown>).filter((v) => !isEmptyValue(v)).length >= 2,
    ).length;
    score += Math.min(1, 0.25 * filled);            // 여러 건으로 잘 쪼갰으면 가점
  } else if (f.kind === "longtext" && typeof value === "string") {
    const n = value.trim().length;
    score += n >= 30 && n <= 800 ? 0.4 : n < 15 ? -0.4 : 0;
  }
  return score;
}

/**
 * 여러 추출 결과에서 **필드별로 더 나은 쪽**만 골라 합친다.
 *
 * '좋은 부분만 합친다'는 게 핵심이다. 값싼 모델 두 번의 합집합이
 * 비싼 모델 한 번보다 나은 경우가 많다 — 서로 놓친 항목이 다르기 때문이다.
 */
export function mergeDrafts(
  type: ExperienceTypeSpec,
  drafts: ExtractionResult[],
  idx: SourceIndex,
): { result: ExtractionResult; conflicts: FieldConflict[] } {
  const fields = allFieldsFor(type);
  const values: Record<string, unknown> = {};
  const provenance: FieldValue[] = [];
  const conflicts: FieldConflict[] = [];

  for (const f of fields) {
    const cands = drafts
      .map((d) => ({ value: d.values[f.key], draft: d, score: fieldScore(f, d.values[f.key], d.provenance, idx) }))
      .sort((a, b) => b.score - a.score);
    const best = cands[0]!;

    if (isEmptyValue(best.value)) {
      values[f.key] = null;
      continue;
    }

    if (f.kind === "repeater") {
      // repeater는 '고른다'가 아니라 '합친다' — 서로 다른 건을 잡았을 수 있다
      values[f.key] = mergeRows(f, cands.map((c) => c.value).filter(Array.isArray) as unknown[][]);
    } else {
      values[f.key] = best.value;
      const other = cands.slice(1).find((c) => !isEmptyValue(c.value)
        && JSON.stringify(c.value) !== JSON.stringify(best.value));
      if (other && Math.abs(other.score - best.score) < 0.25) {
        conflicts.push({ key: f.key, label: f.label, kind: f.kind, options: [best.value, other.value] });
      }
    }
    provenance.push(...provFor(best.draft.provenance, f.key));
  }

  // 비어 있는 항목만 unfilled로 남긴다
  const seen = new Set<string>();
  const unfilled = drafts
    .flatMap((d) => d.unfilled)
    .filter((u) => {
      if (seen.has(u.path)) return false;
      seen.add(u.path);
      return isEmptyValue(values[u.path.split(".")[0]!.replace(/\[\d+\]$/, "")]);
    });

  return { result: { values, provenance, unfilled }, conflicts };
}

/** 반복 입력 행 합치기 — 첫 번째 필수 칸을 키로 중복 제거하고 더 꽉 찬 행을 남긴다. */
function mergeRows(f: FieldSpec, lists: unknown[][]): unknown[] | null {
  const subs = f.fields ?? [];
  const keyField = subs.find((x) => x.required)?.key ?? subs[0]?.key;
  if (!keyField) return lists[0] ?? null;

  const bucket = new Map<string, { row: Record<string, unknown>; filled: number }>();
  for (const list of lists) {
    for (const raw of list ?? []) {
      if (!raw || typeof raw !== "object") continue;
      const row = raw as Record<string, unknown>;
      const k = fold(String(row[keyField] ?? ""));
      if (!k) continue;
      const filled = Object.values(row).filter((v) => !isEmptyValue(v)).length;
      const cur = bucket.get(k);
      if (!cur || filled > cur.filled) {
        bucket.set(k, { row: { ...row }, filled });
      } else {
        for (const [sk, sv] of Object.entries(row)) {   // 같은 행이면 빈 칸만 채워 넣는다
          if (isEmptyValue(cur.row[sk]) && !isEmptyValue(sv)) cur.row[sk] = sv;
        }
      }
    }
  }
  const rows = [...bucket.values()].map((b) => b.row);
  return rows.length ? rows : null;
}

/* ── 충돌 중재 ─────────────────────────────────────────────────── */

const ARBITER_SYSTEM = `두 개의 정리 결과가 같은 항목에서 다른 값을 냈다.
원문 근거만 보고 **어느 쪽이 맞는지** 고르거나, 둘을 합친 더 정확한 값을 쓴다.

1. 원문에 근거가 있는 쪽을 고른다. 둘 다 근거가 있으면 더 구체적인 쪽(수치·고유명사 포함).
2. 한쪽이 과장·왜곡이면(참여→주도, 시도→달성) 보수적인 쪽을 고른다.
3. 둘 다 부정확하면 choice="neither" 로 두고 비운다.
4. 합치는 게 나으면 choice="merged" 와 merged 값을 쓴다. 원문에 없는 말을 보태지 않는다.`;

const ARBITER_SCHEMA = {
  type: "object",
  properties: {
    decisions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          key: { type: "string" },
          choice: { type: "string", enum: ["A", "B", "merged", "neither"] },
          merged: { type: ["string", "null"] },
          reason: { type: "string" },
        },
        required: ["key", "choice", "merged", "reason"], additionalProperties: false,
      },
    },
  },
  required: ["decisions"], additionalProperties: false,
} as const;

/** 충돌 필드만 골라 값싼 모델 1회로 중재한다. 전체 문서를 다시 보낼 필요가 없다. */
export async function arbitrate(
  session: LlmSession,
  conflicts: FieldConflict[],
  factsheet: string,
): Promise<Record<string, unknown>> {
  if (!conflicts.length) return {};
  const lines = conflicts.slice(0, 12).map((c) =>
    `[${c.key}] ${c.label} (${c.kind})\n  A: ${JSON.stringify(c.options[0]).slice(0, 500)}` +
    `\n  B: ${JSON.stringify(c.options[1]).slice(0, 500)}`);

  const raw = await session.structured<{
    decisions: { key: string; choice: string; merged: string | null; reason: string }[];
  }>({
    stage: "extract",
    systemStable: ARBITER_SYSTEM,
    toolName: "submit_arbitration",
    toolDescription: "충돌 항목의 판정을 제출한다.",
    schema: ARBITER_SCHEMA as unknown as Record<string, unknown>,
    content: [
      { type: "text", text: `## 원문에서 뽑은 사실\n${factsheet}` },
      { type: "text", text: `## 판단할 충돌 항목\n${lines.join("\n\n")}` },
    ],
    maxTokens: 8000,
    light: true,
  });

  const byKey = new Map(conflicts.map((c) => [c.key, c]));
  const out: Record<string, unknown> = {};
  for (const d of raw.decisions ?? []) {
    const c = byKey.get(d.key);
    if (!c) continue;
    if (d.choice === "A") out[c.key] = c.options[0];
    else if (d.choice === "B") out[c.key] = c.options[1];
    else if (d.choice === "merged" && d.merged) out[c.key] = d.merged;
    else if (d.choice === "neither") out[c.key] = null;
  }
  return out;
}
