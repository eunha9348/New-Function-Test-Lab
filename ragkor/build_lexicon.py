"""RAGKOR 사전 생성기 — 시드 825개를 규칙으로 1만 건까지 불린다.

'학습'이라는 말을 신경망 훈련으로 오해하지 않도록 분명히 해둔다.
RAGKOR는 **규칙 기반 어휘 자원 + 자모 유사도 매처**다. GPU도 코퍼스 라이선스도
필요 없고, 모든 항목이 어느 규칙에서 나왔는지 역추적된다(provenance).
그래서 틀린 항목을 발견하면 그 규칙만 고치면 된다 — 재학습이 필요 없다.

확장 규칙
  ① 굴절(infl)   : 개선 → 개선하다/개선했다/개선하는/개선함/개선되다/개선된/개선됨
  ② 접사(affix)  : 효율 → 효율화/효율성/효율적/고효율/저효율
  ③ 오타(typo)   : 개선 → 게선/깨선/개션  (자판 인접·모음 혼동 규칙)
  ④ 변이(variant): 컨텐츠 → 콘텐츠        (표기 흔들림)
  ⑤ 구어(collo)  : 갈아넣다 → 집중투입하다 (신조어·커뮤니티체)
"""
import json
import re
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Set

from .jamo import typo_variants
from .seed import (ABBREVIATIONS, NEOLOGISMS, SEED_CLUSTERS, SPELLING_VARIANTS,
                   TYPO_SEEDS)

OUT = Path(__file__).parent / "lexicon.json"

# ① 굴절 — 서술성 명사에 붙는 어미. '개선'이 '개선했습니다'로 나타나도 잡는다.
INFLECTIONS = ["하다", "했다", "하는", "하여", "하고", "함", "하기", "한",
               "했음", "했습니다", "하였다", "해왔다", "하려", "하도록", "하며", "해야",
               "되다", "됐다", "되는", "되어", "된", "됨", "되었다", "됐음", "되었습니다",
               "시키다", "시킴", "시켰다"]
# '하다'가 붙는 서술성 명사 클러스터만 굴절시킨다.
# 이 화이트리스트가 없으면 '성과하다' 같은 비문이 사전을 오염시킨다.
INFLECTABLE_HEADS = {
    "개선", "감소", "증가", "달성", "해결", "기여", "수상", "인정",
    "담당", "주도", "참여", "보조", "협업", "소통", "조율", "기획", "개발",
    "운영", "분석", "발표", "교육", "검증", "리뷰", "대응", "예방",
    "학습", "회고", "성장", "배포", "자동화", "봉사", "주최", "실패",
    "시작", "종료", "마감", "계획", "목표", "동기",
}

# ② 접사 — 한자어 조어력. 실제 문서에 압도적으로 자주 나타난다.
SUFFIXES = ["화", "성", "적", "력", "도", "율", "량", "치"]
PREFIXES = ["재", "고", "저", "초", "신", "구", "최", "비", "미"]
AFFIX_STEMS = ["효율", "안정", "확장", "생산", "정확", "신뢰", "가독", "재사용",
               "유지보수", "일관", "완성", "차별", "지속", "접근", "호환", "최적",
               "자동", "표준", "통합", "분산", "병렬", "실시간", "동시", "독립"]


def _expand_inflections(word: str, head: str = "") -> List[str]:
    """head(대표형)가 서술성 클러스터일 때만 굴절형을 만든다."""
    if head and head not in INFLECTABLE_HEADS:
        return []
    if len(word) < 2 or not re.fullmatch(r"[가-힣]+", word):
        return []
    if word.endswith(("하다", "되다", "다", "음", "함", "기")):
        return []
    return [word + suf for suf in INFLECTIONS]


def _expand_affixes(stem: str) -> List[str]:
    out = [stem + s for s in SUFFIXES]
    out += [p + stem for p in PREFIXES]
    return out


def build(target: int = 10_000) -> dict:
    """후보를 전부 만든 뒤 **우선순위 예산제**로 목표 건수에 맞춰 고른다.

    무작정 불리면 '고효율하다' 같은 비문이 사전을 오염시킨다.
    그래서 규칙마다 상한을 두고, 가치가 높은 규칙부터 채운다.
    오타(typo)는 이 앱에서 가장 자주 마주치는 문제라 넉넉히 배정한다.
    """
    # (규칙, 상한) — 앞에서부터 채운다. None이면 무제한.
    BUDGET = [("seed", None), ("variant", None), ("collo", None), ("abbr", None),
              ("affix-stem", None), ("affix", None),
              ("typo", 4200), ("infl", 4200), ("affix+infl", 900),
              ("collo+infl", 600)]

    pool: Dict[str, List[tuple]] = {r: [] for r, _ in BUDGET}
    clusters: List[dict] = []
    seen_surface = set()

    def cand(rule: str, surface: str, canonical: str):
        surface = surface.strip()
        if not surface or surface in seen_surface:
            return
        seen_surface.add(surface)
        pool[rule].append((surface, canonical))

    # ── 의미 클러스터 ──────────────────────────────────────────────
    canon_of: Dict[str, str] = {}
    for cid, (head, members_raw, domain) in enumerate(SEED_CLUSTERS):
        members = members_raw.split()
        clusters.append({"id": cid, "canon": head, "domain": domain, "members": members})
        for m in members:
            canon_of.setdefault(m, head)
            cand("seed", m, head)

    for wrong, right in SPELLING_VARIANTS.items():
        base = canon_of.get(right, right)
        canon_of.setdefault(wrong, base)
        cand("variant", right, base)
        cand("variant", wrong, base)
    for slang, plain in NEOLOGISMS.items():
        base = canon_of.get(plain, plain)
        canon_of.setdefault(slang, base)
        cand("collo", slang, base)
    for short, full in ABBREVIATIONS.items():
        base = canon_of.get(full, full)
        canon_of.setdefault(short, base)
        cand("abbr", full, base)
        cand("abbr", short, base)
    for stem in AFFIX_STEMS:
        canon_of.setdefault(stem, stem)
        cand("affix-stem", stem, stem)
        for w in _expand_affixes(stem):
            canon_of.setdefault(w, stem)
            cand("affix", w, stem)

    # ── 굴절: 서술성이 살아 있는 말에만 붙인다 ──────────────────────
    for m, head in list(canon_of.items()):
        for inf in _expand_inflections(m, head):
            cand("infl", inf, head)
    for stem in AFFIX_STEMS:
        for w in _expand_affixes(stem):
            if w.endswith(("화", "성")):          # 효율화하다 O / 고효율하다 X
                for inf in _expand_inflections(w):
                    cand("affix+infl", inf, stem)
    for slang, plain in NEOLOGISMS.items():
        head = canon_of.get(plain, plain)
        for inf in _expand_inflections(slang, head if head in INFLECTABLE_HEADS else "개선"):
            cand("collo+infl", inf, head)

    # ── 오타: 실제로 자주 치는 말에만, 자판 인접·모음 혼동 규칙으로 ──
    typo_targets = list(dict.fromkeys(
        TYPO_SEEDS
        + [m for c in clusters for m in c["members"]]
        + list(SPELLING_VARIANTS.values())
        + list(ABBREVIATIONS.values())
    ))
    for word in typo_targets:
        base = canon_of.get(word, word)
        for t in typo_variants(word, limit=14):
            cand("typo", t, base)

    # ── 예산제 선택 ───────────────────────────────────────────────
    canon: Dict[str, str] = {}
    origin: Dict[str, str] = {}
    for rule, cap in BUDGET:
        items = pool[rule]
        if cap is not None:
            items = items[:cap]
        for surface, canonical in items:
            if len(canon) >= target:
                break
            canon[surface] = canonical
            origin[surface] = rule
        if len(canon) >= target:
            break

    # ── 충돌 검사: 같은 말이 서로 다른 대표형으로 새어 들어갔는지 ──────
    intended: Dict[str, Set[str]] = {}
    for rule, _ in BUDGET:
        for surface, canonical in pool[rule]:
            intended.setdefault(surface, set()).add(canonical)
    conflicts = {k: sorted(v) for k, v in intended.items() if len(v) > 1}

    stats = Counter(origin.values())
    return {
        "conflicts": conflicts,
        "version": "1.0",
        "name": "RAGKOR",
        "built_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "entries": len(canon),
        "stats": dict(sorted(stats.items(), key=lambda x: -x[1])),
        "clusters": clusters,
        "canon": canon,
        "origin": origin,
    }


if __name__ == "__main__":
    lex = build()
    OUT.write_text(json.dumps(lex, ensure_ascii=False), encoding="utf-8")
    print(f"RAGKOR 사전 생성: {lex['entries']:,}개 표면형 / 클러스터 {len(lex['clusters'])}개")
    print(f"  → {OUT} ({OUT.stat().st_size/1024:.0f} KB)")
    for rule, n in lex["stats"].items():
        print(f"  {rule:16s} {n:6,}")
    if lex["conflicts"]:
        print(f"  ⚠ 대표형 충돌 {len(lex['conflicts'])}건: "
              f"{list(lex['conflicts'].items())[:3]}")
    else:
        print("  충돌 없음")
