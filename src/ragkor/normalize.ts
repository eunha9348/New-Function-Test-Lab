/**
 * 표기 정규화 — 같은 말을 같은 모양으로 만든다.
 *
 * 근거 검증이 무너지는 이유는 대부분 '의미'가 아니라 '표기'다.
 * 말줄임표 하나, 표 파이프 하나, OCR이 끼워 넣은 페이지 머리말 하나로
 * exact match가 실패한다. 여기서 그 노이즈를 전부 걷어낸다.
 */

/** 조사 — 길이 긴 것부터 벗겨야 '에서는'이 '에'로 잘못 잘리지 않는다 */
export const PARTICLES = [
  "이라고는", "이라고", "라고는", "이라는", "라는", "으로서", "으로써", "로서", "로써",
  "에서는", "에게서", "한테서", "에서도", "에서의", "으로의", "에게는", "한테는",
  "에서", "에게", "한테", "으로", "께서", "부터", "까지", "처럼", "보다", "마다",
  "조차", "마저", "밖에", "이나", "나마", "라도", "이든", "든지", "이란", "이며",
  "이고", "과의", "와의", "의", "은", "는", "이", "가", "을", "를", "에", "로",
  "와", "과", "도", "만", "께", "야", "아", "여", "랑", "이랑",
].sort((a, b) => b.length - a.length);

/** 용언 어미 — '개선했습니다/개선하여/개선함' 을 모두 '개선' 으로 */
export const ENDINGS = [
  "하였습니다", "했었습니다", "하겠습니다", "합니다", "했습니다", "됩니다", "되었습니다",
  "하였으며", "하였고", "하였다", "하였음", "했으며", "했었다", "하면서", "하도록",
  "시켰다", "시키는", "시킨", "되었다", "되었으며", "되어야", "되었고", "되는", "되어",
  "스러운", "스럽게", "스럽다", "롭게", "로운", "롭다",
  "했다", "한다", "하는", "하여", "하고", "해서", "해야", "했던", "하던", "하지",
  "하기", "하며", "할", "함", "됨", "된", "될", "돼", "됐다", "됐음",
  "습니다", "았다", "었다", "이다", "였다", "임", "음", "기",
].sort((a, b) => b.length - a.length);

/* 문서 구조 노이즈 — OCR/마크다운이 끼워 넣는 것들 */
const MD_TABLE = /\|[\s:\-]*\|/g;
const MD_RULE = /^[ \t]*[-=*_]{3,}[ \t]*$/gm;
const MD_MARK = /[|*_`~>#]/g;
const BULLET = /^[ \t]*(?:[-•◦▪▶■●○◆□※·]|\d{1,2}[.)]|[가-힣][.)]|\([0-9가-힣]+\))[ \t]*/gm;
const PAGE = /^[ \t]*[-—–]?[ \t]*\d{1,3}[ \t]*[-—–]?[ \t]*$/gm;
const PAGEMARK = /(?:page|페이지|쪽)\s*\d+\s*(?:\/\s*\d+)?/gi;
const UNCERTAIN = /«불명»|\[손글씨\]|\[\[NO_TEXT\]\]/g;
const PUNCT =
  /[.,·:;'"“”‘’()\[\]{}\-—–_/\\|…‥~〜!?､、。「」『』《》〈〉【】＜＞%％&@+＋*^°℃㎡№¶§†‡→←↔⇒⇔▲▼◀▶]/g;
const SPACE = /[\s\u200b\u00a0\ufeff]+/g;
const TOKEN = /[가-힣]+|[A-Za-z][A-Za-z0-9+#.]*|\d[\d,.]*/g;

/** 사람이 읽을 수 있는 형태는 유지하면서 구조 노이즈만 제거. */
export function clean(text: string): string {
  let s = (text ?? "").normalize("NFKC");
  s = s.replace(UNCERTAIN, " ");
  s = s.replace(PAGE, "");
  s = s.replace(PAGEMARK, " ");
  s = s.replace(MD_RULE, "");
  s = s.replace(MD_TABLE, " ");
  s = s.replace(BULLET, "");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

/** 비교 전용 — 구두점·공백·대소문자를 전부 날린 '뼈대'만 남긴다. */
export function fold(text: string): string {
  let s = clean(text);
  s = s.replace(MD_MARK, "");
  s = s.replace(PUNCT, "");
  s = s.replace(SPACE, "");
  return s.toLowerCase();
}

/** 명사에서 조사를 떼어낸다. 2글자 이하는 건드리지 않는다(오히려 망가진다). */
export function stripParticle(token: string): string {
  if (token.length <= 2) return token;
  for (const p of PARTICLES) {
    if (token.endsWith(p) && token.length - p.length >= 2) return token.slice(0, -p.length);
  }
  return token;
}

/** 용언 어미를 정규화한다. '개선했습니다' → '개선'. */
export function stem(token: string): string {
  let t = token;
  for (let round = 0; round < 2; round++) {
    let changed = false;
    for (const e of ENDINGS) {
      if (t.endsWith(e) && t.length - e.length >= 2) {
        t = t.slice(0, -e.length);
        changed = true;
        break;
      }
    }
    if (!changed) break;
  }
  return t;
}

const UNIT: Record<string, number> = { "천": 1000, "만": 10000, "억": 100000000, "조": 1000000000000 };

/** '18,799' '18799' '1만 8799' 를 같은 값으로 본다. 비교 실패의 단골 원인. */
export function normalizeNumber(raw: string): string {
  const s = String(raw).trim().replace(/,/g, "").replace(/\s/g, "");
  const m = /^(\d+(?:\.\d+)?)([천만억조])?$/.exec(s);
  if (!m) return s;
  let value = parseFloat(m[1]!);
  if (m[2]) value *= UNIT[m[2]]!;
  return Number.isInteger(value) ? String(value) : String(value);
}

export function normalizeToken(token: string): string {
  const t = token.trim().toLowerCase();
  if (!t) return "";
  if (/^\d[\d,.]*$/.test(t)) return normalizeNumber(t);
  if (/^[가-힣]+$/.test(t)) return stem(stripParticle(t));
  return t.replace(/\.+$/, "");
}

/** 텍스트 안의 모든 수치를 정규화해서 모은다 (단위 표기 변형 포함). */
export function numbersIn(text: string): Set<string> {
  const out = new Set<string>();
  const re = /(\d[\d,]*(?:\.\d+)?)\s*([천만억조])?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text ?? "")) !== null) {
    out.add(normalizeNumber(m[1]! + (m[2] ?? "")));
    out.add(normalizeNumber(m[1]!));
  }
  return out;
}

export const STOPWORDS = new Set([
  "그리고", "그러나", "하지만", "또한", "그래서", "따라서", "및", "등", "등등", "이런",
  "그런", "저런", "이것", "그것", "저것", "여기", "거기", "저기", "때문", "위해", "통해",
  "대한", "관련", "경우", "정도", "수준", "부분", "내용", "사항", "다음", "이상", "이하",
  "있다", "없다", "같다", "되다", "하다", "이다", "아니", "것이", "것을", "수가", "우리",
  "저희", "자신", "본인", "해당", "각각", "모두", "전체", "일부", "매우", "가장", "정말",
]);

export function tokenize(text: string, dropStopwords = true): string[] {
  const out: string[] = [];
  const cleaned = clean(text);
  TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN.exec(cleaned)) !== null) {
    const t = normalizeToken(m[0]!);
    if (!t) continue;
    if (dropStopwords && STOPWORDS.has(t)) continue;
    if (t.length === 1 && /^[가-힣]$/.test(t)) continue; // 한 글자 한글은 노이즈가 많다
    out.push(t);
  }
  return out;
}

/** 문장 분리 — 숫자 소수점을 문장 끝으로 오인하지 않는다. */
export function sentences(text: string): string[] {
  return clean(text)
    .split(/(?<=[.!?。])\s+|\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length >= 2);
}

export function ngrams(text: string, n = 4): string[] {
  const f = fold(text);
  if (f.length < n) return f ? [f] : [];
  const out: string[] = [];
  for (let i = 0; i <= f.length - n; i++) out.push(f.slice(i, i + n));
  return out;
}
