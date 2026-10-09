"""인용 정렬 — "이 인용이 원문의 몇 번째 글자부터 몇 번째 글자까지인가".

RAGKOR의 quote_score()는 '있다/없다'만 말해 준다. 화면 하이라이트, 감독용 근거 구간,
필드 감사관의 맥락 검사는 모두 원문 위치가 있어야 한다.

RapidFuzz `fuzz.partial_ratio_alignment` 를 그대로 쓴다. 접은 글자열 위에서 정렬하고,
접기 전 원문 좌표로 되돌린다. rapidfuzz가 없으면 같은 정의의 순수 파이썬 구현으로 대체한다.
TypeScript 구현(`src/ragkor/align.ts`)과 같은 점수가 나오는지는
`test/fixtures/align-rapidfuzz.json` 으로 검증한다.
"""
import unicodedata
from typing import List, Optional, Tuple


def fold_with_map(text: str) -> Tuple[str, List[int]]:
    """글자·숫자만 남기고 소문자로 접는다. 각 글자가 원문 몇 번째 글자에서 왔는지 같이 돌려준다."""
    chars: List[str] = []
    mapping: List[int] = []
    for i, ch in enumerate(text or ""):
        for c in unicodedata.normalize("NFKC", ch).lower():
            if c.isalnum():
                chars.append(c)
                mapping.append(i)
    return "".join(chars), mapping


def _lcs(a: str, b: str) -> int:
    row = [0] * (len(b) + 1)
    for ca in a:
        prev = 0
        for j in range(1, len(b) + 1):
            tmp = row[j]
            row[j] = prev + 1 if ca == b[j - 1] else max(row[j], row[j - 1])
            prev = tmp
    return row[len(b)]


def _fallback_alignment(q: str, s: str) -> Tuple[float, int, int]:
    """rapidfuzz가 없을 때 — 길이 m 창을 전부 밀어 보는 정의 그대로의 구현 (느리다)."""
    m = len(q)
    best = (-1.0, 0, min(m, len(s)))
    for st in range(-m + 1, len(s)):
        a, b = max(0, st), min(len(s), st + m)
        if b <= a:
            continue
        w = s[a:b]
        score = 2 * _lcs(w, q) / (m + len(w))
        if score > best[0] + 1e-12:
            best = (score, a, b)
    return best


def partial_ratio_alignment(q: str, s: str) -> Tuple[float, int, int]:
    """접힌 인용 q 를 접힌 원문 s 위에 정렬한다. (점수 0~1, 시작, 끝) — 접힌 좌표."""
    if not q or not s:
        return 0.0, 0, 0
    try:
        from rapidfuzz import fuzz
    except ImportError:
        return _fallback_alignment(q, s)
    if len(q) >= len(s):
        return fuzz.ratio(q, s) / 100, 0, len(s)
    r = fuzz.partial_ratio_alignment(q, s)
    return r.score / 100, r.dest_start, r.dest_end


def align_quote(quote: str, source: str) -> Optional[dict]:
    """인용을 원문에 정렬해 원문 좌표로 돌려준다. 접힌 인용이 4글자 미만이면 None."""
    fq, _ = fold_with_map(quote)
    if len(fq) < 4:
        return None
    fs, mapping = fold_with_map(source)
    if not fs:
        return None
    score, a, b = partial_ratio_alignment(fq, fs)
    # 창 끝의 남는 글자는 잘라 낸다 — 하이라이트가 인용보다 넓어지지 않게
    while a < b and fs[a] not in fq:
        a += 1
    while b > a and fs[b - 1] not in fq:
        b -= 1
    if b <= a:
        return {"start": 0, "end": 0, "score": 0.0}
    return {"start": mapping[a], "end": mapping[b - 1] + 1, "score": round(score, 3)}
