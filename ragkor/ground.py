"""근거 검증 — RAGKOR의 존재 이유.

기존 검증기는 `normalize(quote) in normalize(source)` 였다.
모델이 인용을 조금만 다듬으면(말줄임표, 표 재구성, 페이지 머리말 삽입)
전부 '환각'으로 튀었고, 그 오탐이 감독에게 흘러가 재작업을 유발했다.
여기서는 **n-gram 국소 밀도**로 "원문 어딘가에 이 말이 실제로 있는가"를 잰다.
"""
from typing import Dict, List, Optional, Set, Tuple

from .jamo import similarity
from .match import Lexicon, default_lexicon
from .normalize import STOPWORDS, fold, ngrams, numbers_in, tokenize

GRAM = 4


class SourceIndex:
    """원문 한 벌을 여러 관점으로 색인해 둔다 — 질의마다 다시 훑지 않는다."""

    def __init__(self, texts: List[str], lex: Optional[Lexicon] = None):
        self.lex = lex or default_lexicon()
        self.raw = "\n".join(texts)
        self.folded = fold(self.raw)
        self.postings: Dict[str, List[int]] = {}
        for i in range(max(0, len(self.folded) - GRAM + 1)):
            self.postings.setdefault(self.folded[i:i + GRAM], []).append(i)
        self.numbers: Set[str] = numbers_in(self.raw)
        self.tokens: Set[str] = set(tokenize(self.raw))
        self.canon_tokens: Set[str] = {self.lex.canonical(t) for t in self.tokens}
        self.latin: Set[str] = {t.lower() for t in self.tokens if t[:1].isascii() and t[:1].isalpha()}

    # ── 인용문 검증 ──────────────────────────────────────────────
    def quote_score(self, quote: str) -> Tuple[float, str]:
        """0~1. '원문에 이 말이 이어진 형태로 존재하는 정도'.

        전역 포함률이 아니라 **한 구간에 몰려 있는 정도**를 본다.
        문서 여기저기서 조각을 긁어모아 만든 문장은 점수가 낮게 나온다.
        """
        grams = ngrams(quote, GRAM)
        if not grams:
            return (1.0, "빈 인용") if not fold(quote) else (0.0, "너무 짧음")
        if len(grams) < 3:                       # 아주 짧은 인용은 포함 여부로 족하다
            hit = fold(quote) in self.folded
            return (1.0 if hit else 0.0), ("직접 포함" if hit else "원문에 없음")

        hits: List[Tuple[int, int]] = []         # (원문 위치, 인용 내 gram 번호)
        for idx, g in enumerate(grams):
            for pos in self.postings.get(g, ()):
                hits.append((pos, idx))
        if not hits:
            return 0.0, "일치 구간 없음"

        hits.sort()
        width = int(len(fold(quote)) * 1.8) + 40  # 원문이 좀 더 길어도 허용
        best, left = 0, 0
        window: Dict[int, int] = {}
        for right in range(len(hits)):
            pos, idx = hits[right]
            window[idx] = window.get(idx, 0) + 1
            while hits[right][0] - hits[left][0] > width:
                lidx = hits[left][1]
                window[lidx] -= 1
                if window[lidx] == 0:
                    del window[lidx]
                left += 1
            best = max(best, len(window))
        score = best / len(grams)
        where = "국소 일치" if score >= 0.85 else ("부분 일치" if score >= 0.55 else "산발 일치")
        return score, where

    def verify_quote(self, quote: str) -> dict:
        score, where = self.quote_score(quote)
        if score >= 0.85:
            verdict = "grounded"
        elif score >= 0.55:
            verdict = "weak"
        else:
            verdict = "ungrounded"
        return {"score": round(score, 3), "verdict": verdict, "where": where}

    # ── 값 검증 ─────────────────────────────────────────────────
    def classify_number(self, raw: str) -> str:
        """'원문 그대로' / '원문에서 계산됨' / '근거 없음' 을 가른다.

        '32.9%→55.7%' 가 원문에 있으면 '22.8%p 향상'은 환각이 아니라 **파생값**이다.
        이걸 구분하지 못하면 모델이 옳게 계산한 성과까지 환각으로 지워진다.
        """
        from .normalize import normalize_number
        n = normalize_number(raw)
        if self.check_number(n):
            return "literal"
        try:
            v = float(n)
        except ValueError:
            return "unknown"
        nums: List[float] = []
        for m in self.numbers:
            try:
                nums.append(float(m))
            except ValueError:
                continue
        nums = sorted(set(nums))[:200]
        eps = max(0.05, abs(v) * 1e-6)
        for i, a in enumerate(nums):
            for b in nums[i + 1:]:
                if (abs(abs(a - b) - v) < eps or abs(a + b - v) < eps
                        or (b and abs(a / b * 100 - v) < 0.05)
                        or (a and abs(b / a * 100 - v) < 0.05)
                        or (a and abs((b - a) / a * 100 - v) < 0.05)):
                    return "derived"
        return "unknown"

    def check_number(self, raw: str) -> bool:
        from .normalize import normalize_number
        n = normalize_number(raw)
        if n in self.numbers:
            return True
        # 18,799 ↔ 18799 ↔ 1만8799 는 이미 numbers_in이 흡수한다.
        # 소수점 반올림 표기만 추가로 허용 (22.8 ↔ 22.80)
        try:
            v = float(n)
        except ValueError:
            return False
        for m in self.numbers:
            try:
                if abs(float(m) - v) < 1e-9:
                    return True
            except ValueError:
                continue
        return False

    def check_term(self, term: str, fuzzy: float = 0.88) -> bool:
        """고유명사·용어가 원문에 있는가. 유의어와 오타를 모두 허용한다."""
        t = term.strip()
        if not t or t.lower() in STOPWORDS:
            return True
        if t.lower() in self.latin or t in self.tokens:
            return True
        if fold(t) and fold(t) in self.folded:
            return True
        canon = self.lex.canonical(t)
        if canon in self.canon_tokens:
            return True
        for alt in self.lex.expand(t):              # 유의어로 등장했을 수 있다
            if alt in self.tokens or alt in self.canon_tokens:
                return True
        for src in self.tokens:                     # 오타로 등장했을 수 있다
            if abs(len(src) - len(t)) <= 2 and similarity(t, src) >= fuzzy:
                return True
        return False
