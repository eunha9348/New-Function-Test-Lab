/**
 * RAGKOR 사전 생성기 — 시드 825개를 규칙으로 1만 건까지 불린다.
 *
 * '학습'이라는 말을 신경망 훈련으로 오해하지 않도록 분명히 해둔다.
 * RAGKOR는 **규칙 기반 어휘 자원 + 자모 유사도 매처**다. GPU도 코퍼스 라이선스도
 * 필요 없고, 모든 항목이 어느 규칙에서 나왔는지 역추적된다(origin).
 * 그래서 틀린 항목을 발견하면 그 규칙만 고치면 된다 — 재학습이 필요 없다.
 *
 * 확장 규칙
 *   ① 굴절(infl)   : 개선 → 개선하다/개선했다/개선하는/개선함/개선되다/개선된/개선됨
 *   ② 접사(affix)  : 효율 → 효율화/효율성/효율적/고효율/저효율
 *   ③ 오타(typo)   : 개선 → 게선/깨선/개션  (자판 인접·모음 혼동 규칙)
 *   ④ 변이(variant): 컨텐츠 → 콘텐츠        (표기 흔들림)
 *   ⑤ 구어(collo)  : 갈아넣다 → 집중투입하다 (신조어·커뮤니티체)
 */
import { typoVariants } from "./jamo.js";
import {
  ABBREVIATIONS, NEOLOGISMS, SEED_CLUSTERS, SPELLING_VARIANTS, TYPO_SEEDS,
} from "./seed.js";

export interface Cluster {
  id: number;
  canon: string;
  domain: string;
  members: string[];
}

export interface LexiconData {
  version: string;
  name: string;
  entries: number;
  stats: Record<string, number>;
  conflicts: Record<string, string[]>;
  clusters: Cluster[];
  canon: Record<string, string>;
  origin: Record<string, string>;
}

/** ① 굴절 — 서술성 명사에 붙는 어미. '개선'이 '개선했습니다'로 나타나도 잡는다. */
const INFLECTIONS = [
  "하다", "했다", "하는", "하여", "하고", "함", "하기", "한",
  "했음", "했습니다", "하였다", "해왔다", "하려", "하도록", "하며", "해야",
  "되다", "됐다", "되는", "되어", "된", "됨", "되었다", "됐음", "되었습니다",
  "시키다", "시킴", "시켰다",
];

/**
 * '하다'가 붙는 서술성 명사 클러스터만 굴절시킨다.
 * 이 화이트리스트가 없으면 '성과하다' 같은 비문이 사전을 오염시킨다.
 */
const INFLECTABLE_HEADS = new Set([
  "개선", "감소", "증가", "달성", "해결", "기여", "수상", "인정",
  "담당", "주도", "참여", "보조", "협업", "소통", "조율", "기획", "개발",
  "운영", "분석", "발표", "교육", "검증", "리뷰", "대응", "예방",
  "학습", "회고", "성장", "배포", "자동화", "봉사", "주최", "실패",
  "시작", "종료", "마감", "계획", "목표", "동기",
]);

/** ② 접사 — 한자어 조어력. 실제 문서에 압도적으로 자주 나타난다. */
const SUFFIXES = ["화", "성", "적", "력", "도", "율", "량", "치"];
const PREFIXES = ["재", "고", "저", "초", "신", "구", "최", "비", "미"];
const AFFIX_STEMS = [
  "효율", "안정", "확장", "생산", "정확", "신뢰", "가독", "재사용",
  "유지보수", "일관", "완성", "차별", "지속", "접근", "호환", "최적",
  "자동", "표준", "통합", "분산", "병렬", "실시간", "동시", "독립",
];

function expandInflections(word: string, head = ""): string[] {
  if (head && !INFLECTABLE_HEADS.has(head)) return [];
  if (word.length < 2 || !/^[가-힣]+$/.test(word)) return [];
  if (/(하다|되다|다|음|함|기)$/.test(word)) return [];
  return INFLECTIONS.map((suf) => word + suf);
}

function expandAffixes(stem: string): string[] {
  return [...SUFFIXES.map((s) => stem + s), ...PREFIXES.map((p) => p + stem)];
}

/**
 * 후보를 전부 만든 뒤 **우선순위 예산제**로 목표 건수에 맞춰 고른다.
 *
 * 무작정 불리면 '고효율하다' 같은 비문이 사전을 오염시킨다.
 * 그래서 규칙마다 상한을 두고, 가치가 높은 규칙부터 채운다.
 * 오타(typo)는 이 앱에서 가장 자주 마주치는 문제라 넉넉히 배정한다.
 */
export function buildLexicon(target = 10_000): LexiconData {
  const BUDGET: [string, number | null][] = [
    ["seed", null], ["variant", null], ["collo", null], ["abbr", null],
    ["affix-stem", null], ["affix", null],
    ["typo", 4200], ["infl", 4200], ["affix+infl", 900], ["collo+infl", 600],
  ];

  const pool = new Map<string, [string, string][]>(BUDGET.map(([r]) => [r, []]));
  const clusters: Cluster[] = [];
  const seenSurface = new Set<string>();
  const canonOf = new Map<string, string>();

  const cand = (rule: string, surface: string, canonical: string) => {
    const s = surface.trim();
    if (!s || seenSurface.has(s)) return;
    seenSurface.add(s);
    pool.get(rule)!.push([s, canonical]);
  };

  SEED_CLUSTERS.forEach(([head, membersRaw, domain], cid) => {
    const members = membersRaw.split(/\s+/).filter(Boolean);
    clusters.push({ id: cid, canon: head, domain, members });
    for (const m of members) {
      if (!canonOf.has(m)) canonOf.set(m, head);
      cand("seed", m, head);
    }
  });

  for (const [wrong, right] of Object.entries(SPELLING_VARIANTS)) {
    const base = canonOf.get(right) ?? right;
    if (!canonOf.has(wrong)) canonOf.set(wrong, base);
    cand("variant", right, base);
    cand("variant", wrong, base);
  }
  for (const [slang, plain] of Object.entries(NEOLOGISMS)) {
    const base = canonOf.get(plain) ?? plain;
    if (!canonOf.has(slang)) canonOf.set(slang, base);
    cand("collo", slang, base);
  }
  for (const [short, full] of Object.entries(ABBREVIATIONS)) {
    const base = canonOf.get(full) ?? full;
    if (!canonOf.has(short)) canonOf.set(short, base);
    cand("abbr", full, base);
    cand("abbr", short, base);
  }
  for (const stem of AFFIX_STEMS) {
    if (!canonOf.has(stem)) canonOf.set(stem, stem);
    cand("affix-stem", stem, stem);
    for (const w of expandAffixes(stem)) {
      if (!canonOf.has(w)) canonOf.set(w, stem);
      cand("affix", w, stem);
    }
  }

  // ── 굴절: 서술성이 살아 있는 말에만 붙인다 ──
  for (const [m, head] of [...canonOf.entries()]) {
    for (const inf of expandInflections(m, head)) cand("infl", inf, head);
  }
  for (const stem of AFFIX_STEMS) {
    for (const w of expandAffixes(stem)) {
      if (w.endsWith("화") || w.endsWith("성")) {       // 효율화하다 O / 고효율하다 X
        for (const inf of expandInflections(w)) cand("affix+infl", inf, stem);
      }
    }
  }
  for (const [slang, plain] of Object.entries(NEOLOGISMS)) {
    const head = canonOf.get(plain) ?? plain;
    const gate = INFLECTABLE_HEADS.has(head) ? head : "개선";
    for (const inf of expandInflections(slang, gate)) cand("collo+infl", inf, head);
  }

  // ── 오타: 실제로 자주 치는 말에만, 자판 인접·모음 혼동 규칙으로 ──
  const typoTargets = [...new Set([
    ...TYPO_SEEDS,
    ...clusters.flatMap((c) => c.members),
    ...Object.values(SPELLING_VARIANTS),
    ...Object.values(ABBREVIATIONS),
  ])];
  for (const word of typoTargets) {
    const base = canonOf.get(word) ?? word;
    for (const t of typoVariants(word, 14)) cand("typo", t, base);
  }

  // ── 충돌 검사: 같은 말이 서로 다른 대표형으로 새어 들어갔는지 ──
  const intended = new Map<string, Set<string>>();
  for (const [rule] of BUDGET) {
    for (const [surface, canonical] of pool.get(rule)!) {
      if (!intended.has(surface)) intended.set(surface, new Set());
      intended.get(surface)!.add(canonical);
    }
  }
  const conflicts: Record<string, string[]> = {};
  for (const [k, v] of intended) if (v.size > 1) conflicts[k] = [...v].sort();

  // ── 예산제 선택 ──
  const canon: Record<string, string> = {};
  const origin: Record<string, string> = {};
  let n = 0;                                   // Object.keys(...).length 를 매번 세면 O(n^2)이 된다
  outer: for (const [rule, cap] of BUDGET) {
    const items = cap === null ? pool.get(rule)! : pool.get(rule)!.slice(0, cap);
    for (const [surface, canonical] of items) {
      if (n >= target) break outer;
      canon[surface] = canonical;
      origin[surface] = rule;
      n++;
    }
  }

  const stats: Record<string, number> = {};
  for (const r of Object.values(origin)) stats[r] = (stats[r] ?? 0) + 1;

  return {
    version: "1.0",
    name: "RAGKOR",
    entries: Object.keys(canon).length,
    stats: Object.fromEntries(Object.entries(stats).sort((a, b) => b[1] - a[1])),
    conflicts,
    clusters,
    canon,
    origin,
  };
}
