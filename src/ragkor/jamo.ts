/**
 * 한글 자모 처리 — RAGKOR의 오타 내성은 전부 여기서 나온다.
 *
 * 한국어 오타는 글자 단위로 재면 거리가 과장된다.
 *   '개선' vs '게선' → 글자 거리 1 (한 글자가 통째로 다름)
 *   자모로 펴면      ㄱㅐㅅㅓㄴ vs ㄱㅔㅅㅓㄴ → 거리 1/5 (모음 하나만 다름)
 * 그래서 모든 유사도 계산을 자모 레벨에서 한다.
 */

export const CHO = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ";
export const JUNG = "ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ";
export const JONG = [
  "", "ㄱ", "ㄲ", "ㄳ", "ㄴ", "ㄵ", "ㄶ", "ㄷ", "ㄹ", "ㄺ", "ㄻ", "ㄼ", "ㄽ",
  "ㄾ", "ㄿ", "ㅀ", "ㅁ", "ㅂ", "ㅄ", "ㅅ", "ㅆ", "ㅇ", "ㅈ", "ㅊ", "ㅋ",
  "ㅌ", "ㅍ", "ㅎ",
];
const BASE = 0xac00;
const LAST = 0xd7a3;

export function isHangul(ch: string): boolean {
  const c = ch.codePointAt(0);
  return c !== undefined && c >= BASE && c <= LAST;
}

/** '개선' → 'ㄱㅐㅅㅓㄴ'. 한글이 아니면 그대로 둔다. */
export function decompose(text: string): string {
  let out = "";
  for (const ch of text) {
    if (isHangul(ch)) {
      const idx = ch.codePointAt(0)! - BASE;
      out += CHO[Math.floor(idx / 588)]!;
      out += JUNG[Math.floor((idx % 588) / 28)]!;
      const j = JONG[idx % 28]!;
      if (j) out += j;
    } else {
      out += ch;
    }
  }
  return out;
}

export function compose(cho: string, jung: string, jong = ""): string | null {
  const ci = CHO.indexOf(cho);
  const vi = JUNG.indexOf(jung);
  const ti = JONG.indexOf(jong);
  if (ci < 0 || vi < 0 || ti < 0) return null;
  return String.fromCodePoint(BASE + (ci * 21 + vi) * 28 + ti);
}

/* ── 두벌식 자판 인접 관계 — 오타의 8할이 인접키 오입력이다 ───────────── */
const ROWS = ["ㅂㅈㄷㄱㅅㅛㅕㅑㅐㅔ", "ㅁㄴㅇㄹㅎㅗㅓㅏㅣ", "ㅋㅌㅊㅍㅠㅜㅡ"];
const COLS: [string, string][] = [
  ["ㅂ", "ㅁ"], ["ㅈ", "ㄴ"], ["ㄷ", "ㅇ"], ["ㄱ", "ㄹ"], ["ㅅ", "ㅎ"],
  ["ㅛ", "ㅗ"], ["ㅕ", "ㅓ"], ["ㅑ", "ㅏ"], ["ㅐ", "ㅣ"],
  ["ㅁ", "ㅋ"], ["ㄴ", "ㅌ"], ["ㅇ", "ㅊ"], ["ㄹ", "ㅍ"],
  ["ㅗ", "ㅠ"], ["ㅓ", "ㅜ"], ["ㅏ", "ㅡ"],
];

function buildAdjacency(): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (!adj.has(a)) adj.set(a, new Set());
    if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a)!.add(b);
    adj.get(b)!.add(a);
  };
  for (const row of ROWS) {
    for (let i = 0; i < row.length - 1; i++) link(row[i]!, row[i + 1]!);
  }
  for (const [a, b] of COLS) link(a, b);
  // 쌍자음은 같은 키 + Shift — 사실상 같은 자리
  for (const [plain, tense] of [["ㄱ", "ㄲ"], ["ㄷ", "ㄸ"], ["ㅂ", "ㅃ"], ["ㅅ", "ㅆ"], ["ㅈ", "ㅉ"]]) {
    link(plain!, tense!);
  }
  for (const [plain, wide] of [["ㅐ", "ㅒ"], ["ㅔ", "ㅖ"], ["ㅑ", "ㅒ"], ["ㅕ", "ㅖ"]]) {
    link(plain!, wide!);
  }
  return adj;
}

export const ADJACENT = buildAdjacency();

/** 자판과 무관하게 '소리가 같아서' 나는 혼동 — 맞춤법 오류의 주범 */
export const CONFUSABLE: [string, string][] = [
  ["ㅐ", "ㅔ"], ["ㅒ", "ㅖ"], ["ㅚ", "ㅙ"], ["ㅚ", "ㅞ"], ["ㅙ", "ㅞ"],
  ["ㅢ", "ㅣ"], ["ㅢ", "ㅔ"], ["ㅕ", "ㅓ"], ["ㅑ", "ㅏ"],
];
const pairKey = (a: string, b: string) => (a < b ? a + "/" + b : b + "/" + a);
const CONFUSE_SET = new Set(CONFUSABLE.map(([a, b]) => pairKey(a, b)));

/** 자모 치환 비용. 인접키/혼동쌍은 싸게 친다 → 오타에 관대해진다. */
export function jamoCost(a: string, b: string): number {
  if (a === b) return 0;
  if (CONFUSE_SET.has(pairKey(a, b))) return 0.25;
  if (ADJACENT.get(a)?.has(b)) return 0.4;
  return 1;
}

/** 자모 레벨 가중 편집거리. 길이 차가 크면 일찍 포기한다. */
export function weightedDistance(a: string, b: string, cap = 6): number {
  const x = decompose(a);
  const y = decompose(b);
  if (x === y) return 0;
  if (Math.abs(x.length - y.length) > cap) return cap + 1;

  let prev = Array.from({ length: y.length + 1 }, (_, i) => i);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= y.length; j++) {
      const v = Math.min(
        prev[j]! + 1,                                  // 삭제
        cur[j - 1]! + 1,                               // 삽입
        prev[j - 1]! + jamoCost(x[i - 1]!, y[j - 1]!), // 치환
      );
      cur.push(v);
      if (v < best) best = v;
    }
    if (best > cap) return cap + 1;
    prev = cur;
  }
  return prev[y.length]!;
}

/** 0~1. 자모 길이로 정규화한 유사도. */
export function similarity(a: string, b: string): number {
  const n = Math.max(decompose(a).length, decompose(b).length);
  if (n === 0) return 1;
  const d = weightedDistance(a, b, n);
  return Math.max(0, 1 - d / n);
}

/** 자판 인접/혼동 규칙으로 '있을 법한 오타'를 생성한다. 사전 확장에 쓴다. */
export function typoVariants(word: string, limit = 6): string[] {
  const out: string[] = [];
  const chars = [...word];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    if (!isHangul(ch)) continue;
    const idx = ch.codePointAt(0)! - BASE;
    const cho = CHO[Math.floor(idx / 588)]!;
    const jung = JUNG[Math.floor((idx % 588) / 28)]!;
    const jong = JONG[idx % 28]!;
    const head = chars.slice(0, i).join("");
    const tail = chars.slice(i + 1).join("");

    // 모음 혼동 (개선→게선)
    for (const [a, b] of CONFUSABLE) {
      if (jung === a || jung === b) {
        const c = compose(cho, jung === a ? b : a, jong);
        if (c) out.push(head + c + tail);
      }
    }
    // 종성 누락 (했다→하다)
    if (jong) {
      const c = compose(cho, jung);
      if (c) out.push(head + c + tail);
    }
    // 초성 인접키 (개선→내선)
    for (const nb of [...(ADJACENT.get(cho) ?? [])].sort()) {
      if (CHO.includes(nb)) {
        const c = compose(nb, jung, jong);
        if (c) out.push(head + c + tail);
      }
    }
    if (out.length >= limit * 3) break;
  }
  const seen = new Set([word]);
  const uniq: string[] = [];
  for (const w of out) {
    if (seen.has(w)) continue;
    seen.add(w);
    uniq.push(w);
    if (uniq.length >= limit) break;
  }
  return uniq;
}
