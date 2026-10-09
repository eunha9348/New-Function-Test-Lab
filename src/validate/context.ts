import { labelForPath, roleOfPath } from "../schema/index.js";
import { cosine, type Embedder } from "../llm/embed.js";
import type { ExperienceTypeSpec, ExtractedDoc, FieldValue, ReviewIssue } from "../types.js";
import { getByPath, leafPaths } from "../util/path.js";

/**
 * 맥락 검사 — "원문 문장은 진짜인데, 그 문장이 이 칸의 이야기인가".
 *
 * RAGKOR와 정렬기는 표기만 본다. 원문 '11.1 현재의 한계' 구간의 문장을 그대로 가져와
 * '핵심 성과'에 넣으면 일치도 1.0으로 통과한다(RAGKOR 보고서의 알려진 미탐 유형).
 * 여기서는 인용이 놓인 **문장과 섹션의 성격**을 보고 칸의 역할과 맞는지 판단한다.
 *
 *   · 단서어 규칙 — 항상 돈다. 섹션 제목·문장의 '한계/못 했다/예정/성과/달성' 같은 말.
 *   · 임베딩      — Google 키가 있으면 같이 돈다. 단서어가 없는 문장도 성격을 가른다.
 *
 * 오탐을 줄이려고 **정밀도가 높은 규칙만** 넣었다.
 *   1. 성과 칸의 근거가 한계·계획 문장/섹션에서 왔다           → context_mismatch (major)
 *   2. '내가 한 일' 칸의 근거가 주어가 팀인 문장이다            → subject_drift (major)
 *   3. 성과 칸에 변화·결과 없이 행동만 적혀 있다               → context_mismatch (minor)
 */

export type TextRole = "outcome" | "limitation" | "plan" | "action" | "background" | "reflection" | "team";
const ROLES: TextRole[] = ["outcome", "limitation", "plan", "action", "background", "reflection", "team"];

export interface Section {
  title: string;
  start: number;
  end: number;
}

/* ── 섹션 나누기 ──────────────────────────────────────────────── */

const HEADING = [
  /^#{1,6}\s+\S.{0,60}$/,                                   // 마크다운 제목
  /^\d{1,2}(?:\.\d{1,2}){0,3}[.)]?\s+[^.!?。]{1,40}$/,       // '11.1 현재의 한계', '3. 시스템 구성'
  /^\[[^\]]{1,30}\]$/,                                      // [성과]
  /^[■□▶◆●○◎★☆]\s*[^.!?。]{1,40}$/,                        // ■ 성과
  /^[^.!?。:]{1,30}:$/,                                     // '아쉬운 점:'
  /^<[^>]{1,30}>$/,                                         // <회고>
];

export function isHeading(line: string): boolean {
  const l = line.trim();
  if (!l || l.length > 60) return false;
  // '1. 틀린 답이 금전적 손해로 직결된다' 처럼 번호 붙은 서술문은 제목이 아니다
  if (/(다|요|음|함|됨|임)$/.test(l) && /^\d/.test(l)) return false;
  return HEADING.some((re) => re.test(l));
}

export function segmentSections(text: string): Section[] {
  const out: Section[] = [];
  let pos = 0;
  let cur: Section = { title: "", start: 0, end: text.length };
  for (const line of text.split("\n")) {
    if (isHeading(line)) {
      cur.end = pos;
      if (cur.end > cur.start || cur.title) out.push(cur);
      cur = { title: line.trim().replace(/^#+\s*|[[\]<>:■□▶◆●○◎★☆]/g, "").trim(), start: pos, end: text.length };
    }
    pos += line.length + 1;
  }
  cur.end = text.length;
  out.push(cur);
  return out;
}

export function sectionAt(sections: Section[], pos: number): Section | null {
  return sections.find((s) => pos >= s.start && pos < s.end) ?? null;
}

/** 위치를 감싸는 문장 (마침표·줄바꿈 기준) */
export function sentenceAround(text: string, start: number, end: number): string {
  let a = start;
  while (a > 0 && !/[.!?。\n]/.test(text[a - 1]!)) a--;
  let b = end;
  while (b < text.length && !/[.!?。\n]/.test(text[b]!)) b++;
  return text.slice(a, Math.min(text.length, b + 1)).trim();
}

/* ── 단서어 ────────────────────────────────────────────────────── */

const CUES: Record<TextRole, RegExp[]> = {
  outcome: [/성과/, /결과/, /효과/, /달성/, /향상/, /개선(?!할|하려|점|이 필요)/, /감소/, /증가/, /단축/, /절감/,
    /줄었|줄였|줄임|늘었|늘렸|올랐|올렸|높였|낮췄/, /수상|입상|선정|합격|통과(?!하지)/, /→|->/, /%p/, /배\s*(?:향상|증가)/],
  limitation: [/한계/, /문제점/, /리스크/, /제약/, /아쉬/, /못\s*했|못했|못\s*한|못한|하지\s*못/, /포기/, /부족/, /미흡/,
    /실패/, /없다\.?$|없음\.?$|없습니다/, /누락/, /검증(?:이|을)?\s*(?:없|안)/,
    /^\s*[-•]?\s*이슈\s*:/, /놓쳐|놓친|어긋|실수/],
  plan: [/계획/, /예정/, /향후/, /앞으로/, /다음(?:엔|에는|번)/, /하려\s*(?:합니다|한다|고)/, /할\s*것이다/, /로드맵/, /목표(?:는|로)/],
  action: [/담당/, /맡아|맡았/, /설계했|구현했|개발했|작성했|분석했|진행했|수행했|만들었/, /역할/],
  background: [/배경/, /목적/, /동기/, /필요성/, /개요/, /문제\s*정의/, /소개/],
  reflection: [/배운|배웠/, /느낀|느꼈/, /회고/, /소감/, /교훈/, /깨달/],
  team: [/(?:^|\s)(?:우리|저희)\s*팀?(?:은|는|이|가)\s/, /(?:^|\s)팀(?:원들?)?(?:은|는|이|가)\s/, /팀\s*전체/, /구성원/, /협업/],
};

export function cueRoles(text: string): Record<TextRole, number> {
  const out = Object.fromEntries(ROLES.map((r) => [r, 0])) as Record<TextRole, number>;
  for (const r of ROLES) for (const re of CUES[r]) if (re.test(text)) out[r]++;
  return out;
}

const FIRST_PERSON = /(?:^|\s)(?:저는|제가|내가|나는|저의|제\s|본인(?:은|이))/;

/* ── 임베딩 프로토타입 ────────────────────────────────────────── */

const PROTOTYPES: Record<"outcome" | "limitation" | "plan", string[]> = {
  outcome: [
    "개선 결과 응답시간이 820ms에서 210ms로 줄었다",
    "이 작업으로 전환율이 12% 올랐고 사내 우수 사례로 선정되었다",
    "본선에 진출해 최우수상을 받았다",
  ],
  limitation: [
    "현재의 한계는 동시 요청 환경에서의 검증이 없다는 점이다",
    "시간이 부족해 부하 테스트를 하지 못했다",
    "원문 복원 기능은 포기했고 아쉬움이 남는다",
  ],
  plan: [
    "다음에는 부하 테스트를 먼저 하려고 한다",
    "향후 모바일 버전을 출시할 예정이다",
    "목표는 사용자 1만 명을 확보하는 것이다",
  ],
};

class PrototypeScorer {
  private protos: Promise<Record<string, number[][]>> | null = null;
  constructor(private readonly embedder: Embedder) {}

  private load() {
    if (!this.protos) {
      const keys = Object.keys(PROTOTYPES) as (keyof typeof PROTOTYPES)[];
      const all = keys.flatMap((k) => PROTOTYPES[k]);
      this.protos = this.embedder.embed(all).then((vecs) => {
        const out: Record<string, number[][]> = {};
        let i = 0;
        for (const k of keys) out[k] = PROTOTYPES[k].map(() => vecs[i++]!);
        return out;
      });
    }
    return this.protos;
  }

  /** 문장마다 성과/한계/계획 유사도 (프로토타입 최댓값) */
  async score(texts: string[]): Promise<Record<"outcome" | "limitation" | "plan", number>[]> {
    const protos = await this.load();
    const vecs = await this.embedder.embed(texts);
    return vecs.map((v) => {
      const s = (k: string) => Math.max(...protos[k]!.map((p) => cosine(v, p)));
      return { outcome: s("outcome"), limitation: s("limitation"), plan: s("plan") };
    });
  }
}

/* ── 검사 ─────────────────────────────────────────────────────── */

export interface ContextOptions {
  embedder?: Embedder | null;
  /** 임베딩 판정 여유 — 한계/계획 유사도가 성과 유사도보다 이만큼 높아야 지적한다 */
  margin?: number;
}

interface Probe {
  path: string;
  label: string;
  sentence: string;
  section: string;
  quote: string;
}

const ACTION_ONLY = /(적용|구현|개발|설계|작성|도입|구축|진행|참여|운영|기획|분석|제작)(했|하였|함|하여)/;

export async function checkContext(
  type: ExperienceTypeSpec,
  values: Record<string, unknown>,
  provenance: FieldValue[],
  docs: ExtractedDoc[],
  opts: ContextOptions = {},
): Promise<ReviewIssue[]> {
  const issues: ReviewIssue[] = [];
  const seen = new Set<string>();
  const add = (severity: ReviewIssue["severity"], kind: ReviewIssue["type"], path: string, detail: string) => {
    const k = `${path}|${kind}|${detail}`;
    if (seen.has(k)) return;
    seen.add(k);
    issues.push({ severity, type: kind, path, detail, foundBy: "validator" });
  };

  const sections = new Map(docs.map((d) => [d.sourceId, segmentSections(d.text)]));
  const outcomeProbes: Probe[] = [];

  for (const p of provenance) {
    const role = roleOfPath(p.path);
    if (role !== "outcome" && role !== "action") continue;
    const label = labelForPath(type, p.path);
    for (const q of p.quotes) {
      const doc = docs.find((d) => d.sourceId === q.sourceId);
      if (!doc || q.start === undefined || q.end === undefined) continue;
      const sentence = sentenceAround(doc.text, q.start, q.end);
      const sec = sectionAt(sections.get(doc.sourceId) ?? [], q.start);

      if (role === "outcome") {
        outcomeProbes.push({ path: p.path, label, sentence, section: sec?.title ?? "", quote: q.text });
      } else if (CUES.team.some((re) => re.test(` ${sentence}`)) && !FIRST_PERSON.test(` ${sentence}`)) {
        add("major", "subject_drift", p.path,
          `'${label}'의 근거 문장은 주어가 팀입니다: "${sentence.slice(0, 70)}". ` +
          "내가 한 일이라는 근거가 원문에 있을 때만 남기고, 아니면 팀 구성/협업 칸으로 옮기세요.");
      }
    }
  }

  // 1) 성과 칸 ← 한계·계획 문장/섹션
  const scorer = opts.embedder ? new PrototypeScorer(opts.embedder) : null;
  const emb = scorer && outcomeProbes.length
    ? await scorer.score(outcomeProbes.map((p) => p.sentence)).catch(() => null)
    : null;
  const margin = opts.margin ?? 0.03;

  outcomeProbes.forEach((p, i) => {
    const sec = cueRoles(p.section);
    const sen = cueRoles(p.sentence);
    const sectionNeg = (sec.limitation > 0 || sec.plan > 0) && sec.outcome === 0;
    const sentenceNeg = (sen.limitation > 0 || sen.plan > 0) && sen.outcome === 0;
    const e = emb?.[i];
    const embNeg = !!e && Math.max(e.limitation, e.plan) - e.outcome >= margin && sen.outcome === 0;
    if (!(sectionNeg || sentenceNeg || embNeg)) return;
    const why = sectionNeg
      ? `원문 '${p.section}' 구간`
      : sentenceNeg
        ? "한계·계획을 말하는 문장"
        : `한계·계획에 가까운 문장(임베딩 유사도 ${Math.max(e!.limitation, e!.plan).toFixed(2)} > 성과 ${e!.outcome.toFixed(2)})`;
    add("major", "context_mismatch", p.path,
      `'${p.label}'의 근거가 ${why}에서 왔습니다: "${p.sentence.slice(0, 70)}". ` +
      "원문 문장은 맞지만 성과가 아닙니다. 회고·아쉬운 점·다음 계획 칸으로 옮기세요.");
  });

  // 3) 값 자체를 본다 — 근거 위치가 없어도 잡을 수 있는 것들
  const flagged = new Set(issues.map((i) => `${i.path}|${i.type}`));
  for (const path of leafPaths(values)) {
    const role = roleOfPath(path);
    if (role !== "outcome" && role !== "action") continue;
    const v = getByPath(values, path);
    if (typeof v !== "string" || v.trim().length < 8) continue;
    if (role === "action") {
      if (!flagged.has(`${path}|subject_drift`)
        && CUES.team.some((re) => re.test(` ${v}`)) && !FIRST_PERSON.test(` ${v}`)) {
        add("major", "subject_drift", path,
          `'${labelForPath(type, path)}'의 주어가 팀입니다: "${v.slice(0, 60)}". 내가 한 일만 남기세요.`);
      }
      continue;
    }
    if (flagged.has(`${path}|context_mismatch`)) continue;
    const c = cueRoles(v);
    if (c.limitation > 0 && c.outcome === 0) {
      add("major", "context_mismatch", path,
        `'${labelForPath(type, path)}'에 성과가 아니라 한계·못 한 일이 적혀 있습니다: "${v.slice(0, 60)}".`);
    } else if (!/\d/.test(v) && c.outcome === 0 && ACTION_ONLY.test(v)) {
      add("minor", "context_mismatch", path,
        `'${labelForPath(type, path)}'에 결과·변화 없이 행동만 적혀 있습니다: "${v.slice(0, 60)}". ` +
        "원문에 결과가 있으면 그것을, 없으면 이 칸은 비우고 '내가 한 일'로 옮기세요.");
    }
  }

  return issues;
}
