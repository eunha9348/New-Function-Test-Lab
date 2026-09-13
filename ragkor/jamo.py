"""한글 자모 처리 — RAGKOR의 오타 내성은 전부 여기서 나온다.

한국어 오타는 글자 단위로 재면 거리가 과장된다.
  '개선' vs '게선' → 글자 거리 1 (한 글자가 통째로 다름)
  자모로 펴면      ㄱㅐㅅㅓㄴ vs ㄱㅔㅅㅓㄴ → 거리 1/5 (모음 하나만 다름)
그래서 모든 유사도 계산을 자모 레벨에서 한다.
"""
from typing import Dict, List, Set, Tuple

CHO = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ"
JUNG = "ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ"
JONG = ["", "ㄱ", "ㄲ", "ㄳ", "ㄴ", "ㄵ", "ㄶ", "ㄷ", "ㄹ", "ㄺ", "ㄻ", "ㄼ", "ㄽ",
        "ㄾ", "ㄿ", "ㅀ", "ㅁ", "ㅂ", "ㅄ", "ㅅ", "ㅆ", "ㅇ", "ㅈ", "ㅊ", "ㅋ",
        "ㅌ", "ㅍ", "ㅎ"]
BASE, LAST = 0xAC00, 0xD7A3


def is_hangul(ch: str) -> bool:
    return BASE <= ord(ch) <= LAST


def decompose(text: str) -> str:
    """'개선' → 'ㄱㅐㅅㅓㄴ'. 한글이 아니면 그대로 둔다."""
    out = []
    for ch in text:
        if is_hangul(ch):
            idx = ord(ch) - BASE
            out.append(CHO[idx // 588])
            out.append(JUNG[(idx % 588) // 28])
            j = JONG[idx % 28]
            if j:
                out.append(j)
        else:
            out.append(ch)
    return "".join(out)


def compose(cho: str, jung: str, jong: str = "") -> str:
    return chr(BASE + (CHO.index(cho) * 21 + JUNG.index(jung)) * 28 + JONG.index(jong))


# ── 두벌식 자판 인접 관계 — 오타의 8할이 인접키 오입력이다 ───────────────────
_ROWS = [
    "ㅂㅈㄷㄱㅅㅛㅕㅑㅐㅔ",
    "ㅁㄴㅇㄹㅎㅗㅓㅏㅣ",
    "ㅋㅌㅊㅍㅠㅜㅡ",
]
_COLS = [("ㅂ", "ㅁ"), ("ㅈ", "ㄴ"), ("ㄷ", "ㅇ"), ("ㄱ", "ㄹ"), ("ㅅ", "ㅎ"),
         ("ㅛ", "ㅗ"), ("ㅕ", "ㅓ"), ("ㅑ", "ㅏ"), ("ㅐ", "ㅣ"),
         ("ㅁ", "ㅋ"), ("ㄴ", "ㅌ"), ("ㅇ", "ㅊ"), ("ㄹ", "ㅍ"),
         ("ㅗ", "ㅠ"), ("ㅓ", "ㅜ"), ("ㅏ", "ㅡ")]


def _build_adjacency() -> Dict[str, Set[str]]:
    adj: Dict[str, Set[str]] = {}
    def link(a: str, b: str):
        adj.setdefault(a, set()).add(b)
        adj.setdefault(b, set()).add(a)
    for row in _ROWS:
        for i in range(len(row) - 1):
            link(row[i], row[i + 1])
    for a, b in _COLS:
        link(a, b)
    # 쌍자음은 같은 키 + Shift — 사실상 같은 자리
    for plain, tense in [("ㄱ", "ㄲ"), ("ㄷ", "ㄸ"), ("ㅂ", "ㅃ"), ("ㅅ", "ㅆ"), ("ㅈ", "ㅉ")]:
        link(plain, tense)
    for plain, wide in [("ㅐ", "ㅒ"), ("ㅔ", "ㅖ"), ("ㅑ", "ㅒ"), ("ㅕ", "ㅖ")]:
        link(plain, wide)
    return adj


ADJACENT = _build_adjacency()

# 자판과 무관하게 '소리가 같아서' 나는 혼동 — 맞춤법 오류의 주범
CONFUSABLE: List[Tuple[str, str]] = [
    ("ㅐ", "ㅔ"), ("ㅒ", "ㅖ"), ("ㅚ", "ㅙ"), ("ㅚ", "ㅞ"), ("ㅙ", "ㅞ"),
    ("ㅢ", "ㅣ"), ("ㅢ", "ㅔ"), ("ㅕ", "ㅓ"), ("ㅑ", "ㅏ"),
]
CONFUSE_SET = {frozenset(p) for p in CONFUSABLE}


def jamo_cost(a: str, b: str) -> float:
    """자모 치환 비용. 인접키/혼동쌍은 싸게 친다 → 오타에 관대해진다."""
    if a == b:
        return 0.0
    if frozenset((a, b)) in CONFUSE_SET:
        return 0.25
    if b in ADJACENT.get(a, ()):
        return 0.4
    return 1.0


def weighted_distance(a: str, b: str, cap: float = 6.0) -> float:
    """자모 레벨 가중 편집거리. 길이 차가 크면 일찍 포기한다."""
    x, y = decompose(a), decompose(b)
    if x == y:
        return 0.0
    if abs(len(x) - len(y)) > cap:
        return cap + 1
    prev = list(range(len(y) + 1))
    for i, ca in enumerate(x, 1):
        cur = [float(i)]
        best = cur[0]
        for j, cb in enumerate(y, 1):
            cur.append(min(
                prev[j] + 1.0,              # 삭제
                cur[j - 1] + 1.0,           # 삽입
                prev[j - 1] + jamo_cost(ca, cb),  # 치환
            ))
            best = min(best, cur[-1])
        if best > cap:
            return cap + 1
        prev = cur
    return prev[-1]


def similarity(a: str, b: str) -> float:
    """0~1. 자모 길이로 정규화한 유사도."""
    x, y = decompose(a), decompose(b)
    n = max(len(x), len(y))
    if n == 0:
        return 1.0
    d = weighted_distance(a, b, cap=float(n))
    return max(0.0, 1.0 - d / n)


def typo_variants(word: str, limit: int = 6) -> List[str]:
    """자판 인접/혼동 규칙으로 '있을 법한 오타'를 생성한다. 사전 확장에 쓴다."""
    out: List[str] = []
    chars = list(word)
    for i, ch in enumerate(chars):
        if not is_hangul(ch):
            continue
        idx = ord(ch) - BASE
        cho, jung, jong = CHO[idx // 588], JUNG[(idx % 588) // 28], JONG[idx % 28]
        # 모음 혼동 (개선→게선)
        for a, b in CONFUSABLE:
            if jung == a or jung == b:
                alt = b if jung == a else a
                try:
                    out.append("".join(chars[:i]) + compose(cho, alt, jong) + "".join(chars[i + 1:]))
                except ValueError:
                    pass
        # 종성 누락 (했다→하다)
        if jong:
            out.append("".join(chars[:i]) + compose(cho, jung) + "".join(chars[i + 1:]))
        # 초성 인접키 (개선→내선)
        for nb in sorted(ADJACENT.get(cho, ())):
            if nb in CHO:
                try:
                    out.append("".join(chars[:i]) + compose(nb, jung, jong) + "".join(chars[i + 1:]))
                except ValueError:
                    pass
        if len(out) >= limit * 3:
            break
    seen, uniq = {word}, []
    for w in out:
        if w not in seen:
            seen.add(w)
            uniq.append(w)
        if len(uniq) >= limit:
            break
    return uniq
