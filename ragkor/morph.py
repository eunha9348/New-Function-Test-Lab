"""형태소 분석 — Kiwi(kiwipiepy)를 붙이는 자리.

RAGKOR의 조사·어미 떼기는 사람이 쓴 접미 목록(PARTICLES·ENDINGS)과 미리 만들어 둔
굴절형 사전(`infl` 4,200건)으로 돌아갔다. 목록에 없는 활용형('줄였다', '붙여서')은
원형으로 돌아오지 못했다. Kiwi는 활용형을 형태소로 쪼개 원형을 돌려준다.

kiwipiepy가 없으면 기존 규칙으로 그대로 동작한다.
TypeScript 쪽(`src/ragkor/morph.ts`)과 같은 원형 규칙을 쓴다.
"""
from typing import Dict, Optional

NOUNISH = {"NNG", "NNP", "NR", "XR", "SL", "SH", "SN", "XPN"}
VERBISH = {"VV", "VA", "VX", "VCN"}

_kiwi = None
_cache: Dict[str, str] = {}


def lemma_from_morphs(word: str, morphs) -> str:
    """형태소 열 → 원형. 명사·어근 덩어리 > 첫 용언 어간 > 원래 어절."""
    noun = []
    for form, tag in morphs:
        if tag in NOUNISH:
            noun.append(form)
        elif noun and not tag.startswith("XSN"):
            break
    if noun:
        return "".join(noun).lower()
    for form, tag in morphs:
        base = tag.split("-")[0]
        if base in VERBISH:
            return form.lower()
    return word.lower()


def use_kiwi(enable: bool = True) -> bool:
    """Kiwi를 켠다. 설치돼 있지 않으면 False를 돌려주고 규칙 기반을 유지한다."""
    global _kiwi
    if not enable:
        _kiwi = None
        _cache.clear()
        return False
    if _kiwi is not None:
        return True
    try:
        from kiwipiepy import Kiwi
    except ImportError:
        return False
    _kiwi = Kiwi(model_type="cong")
    return True


def kiwi_active() -> bool:
    return _kiwi is not None


def kiwi_lemma(word: str) -> Optional[str]:
    if _kiwi is None:
        return None
    hit = _cache.get(word)
    if hit is None:
        try:
            hit = lemma_from_morphs(word, [(t.form, t.tag) for t in _kiwi.tokenize(word)])
        except Exception:
            hit = word.lower()
        if len(_cache) > 50_000:
            _cache.clear()
        _cache[word] = hit
    return hit
