"""RAGKOR 매처 — 사전 + 자모 유사도 + BM25를 하나로 묶는다."""
import json
import math
import re
from collections import Counter, defaultdict
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Set, Tuple

from .jamo import similarity
from .normalize import fold, ngrams, normalize_token, numbers_in, sentences, tokenize

_LEX_PATH = Path(__file__).parent / "lexicon.json"


class Lexicon:
    """표면형 → 대표형 사전. 없으면 규칙으로 즉석 생성한다(Colab 단일파일 대비)."""

    def __init__(self, data: Optional[dict] = None):
        if data is None:
            data = self._load()
        self.canon: Dict[str, str] = data.get("canon", {})
        self.origin: Dict[str, str] = data.get("origin", {})
        self.clusters: List[dict] = data.get("clusters", [])
        self.entries = len(self.canon)
        self._members: Dict[str, Set[str]] = defaultdict(set)
        for c in self.clusters:
            for m in c["members"]:
                self._members[c["canon"]].add(m)
        for surface, canonical in self.canon.items():
            self._members[canonical].add(surface)
        # 자모 유사도 폴백용 — 사전에 없는 오타를 잡을 때 후보를 좁힌다
        self._by_len: Dict[int, List[str]] = defaultdict(list)
        for s in self.canon:
            self._by_len[len(s)].append(s)

    @staticmethod
    def _load() -> dict:
        if _LEX_PATH.exists():
            return json.loads(_LEX_PATH.read_text(encoding="utf-8"))
        from .build_lexicon import build
        return build()

    def canonical(self, token: str) -> str:
        """표면형을 대표형으로. 사전에 없으면 정규화형을 그대로 돌려준다."""
        t = normalize_token(token)
        if t in self.canon:
            return self.canon[t]
        raw = token.strip().lower()
        return self.canon.get(raw, t)

    def fuzzy_canonical(self, token: str, threshold: float = 0.86) -> Tuple[str, float]:
        """사전에 없는 오타를 자모 거리로 가장 가까운 표제어에 붙인다."""
        t = normalize_token(token)
        if t in self.canon:
            return self.canon[t], 1.0
        best, score = t, 0.0
        for L in (len(t) - 1, len(t), len(t) + 1):
            for cand in self._by_len.get(L, ()):
                s = similarity(t, cand)
                if s > score:
                    best, score = cand, s
                    if s >= 0.99:
                        break
        if score >= threshold:
            return self.canon.get(best, best), score
        return t, 0.0

    def expand(self, token: str) -> Set[str]:
        """검색 확장용 — 같은 뜻으로 쓰이는 표면형을 전부 돌려준다."""
        c = self.canonical(token)
        out = {c, normalize_token(token)}
        out |= self._members.get(c, set())
        return {x for x in out if x}

    def analyze(self, text: str) -> List[str]:
        """텍스트 → 대표형 토큰 열. 비교·검색은 전부 이 형태에서 한다."""
        return [self.canonical(t) for t in tokenize(text)]


_DEFAULT: Optional[Lexicon] = None


def default_lexicon() -> Lexicon:
    global _DEFAULT
    if _DEFAULT is None:
        _DEFAULT = Lexicon()
    return _DEFAULT


class BM25:
    """청크 검색용. 유의어 확장을 질의 쪽에 적용해 재현율을 올린다."""

    def __init__(self, chunks: List[str], lex: Optional[Lexicon] = None,
                 k1: float = 1.4, b: float = 0.72):
        self.lex = lex or default_lexicon()
        self.chunks = chunks
        self.k1, self.b = k1, b
        self.docs = [Counter(self.lex.analyze(c)) for c in chunks]
        self.lens = [sum(d.values()) or 1 for d in self.docs]
        self.avg = sum(self.lens) / max(1, len(self.lens))
        self.df: Counter = Counter()
        for d in self.docs:
            self.df.update(d.keys())
        self.N = max(1, len(self.docs))

    def _idf(self, term: str) -> float:
        n = self.df.get(term, 0)
        return math.log(1 + (self.N - n + 0.5) / (n + 0.5))

    def search(self, query: str, top: int = 5) -> List[Tuple[int, float]]:
        terms: Set[str] = set()
        for t in tokenize(query):
            terms |= {self.lex.canonical(x) for x in self.lex.expand(t)}
        scores = []
        for i, d in enumerate(self.docs):
            s = 0.0
            for term in terms:
                f = d.get(term, 0)
                if not f:
                    continue
                s += self._idf(term) * (f * (self.k1 + 1)) / (
                    f + self.k1 * (1 - self.b + self.b * self.lens[i] / self.avg))
            if s > 0:
                scores.append((i, s))
        scores.sort(key=lambda x: -x[1])
        return scores[:top]
