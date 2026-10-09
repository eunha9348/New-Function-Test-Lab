"""RapidFuzz 기준값을 만든다 — TS 정렬기(`src/ragkor/align.ts`)가 같은 점수를 내는지 검증용.

    python tools/gen_align_fixture.py

벤치마크 원문 3종의 문장마다 모델이 실제로 하는 변형(말줄임표 절단, 줄바꿈 합침 등)을 만들고,
진짜 환각(다른 문서 문장·창작)을 섞어 rapidfuzz 점수와 정답 위치를 기록한다.
"""
import json
import random
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from ragkor.align import align_quote, fold_with_map, partial_ratio_alignment  # noqa: E402
from ragkor.bench import DOCS, _variants  # noqa: E402
from ragkor.normalize import fold  # noqa: E402

FABRICATED = [
    "전국 대회에서 대상을 수상하여 상금 5천만원을 받았습니다",
    "누적 사용자 100만 명을 달성하여 업계 1위를 기록했습니다",
    "특허 3건을 출원하고 SCI 논문 2편을 게재했습니다",
]


def _hard_variants(line: str, rng: random.Random):
    """모델·OCR이 실제로 만드는 더 어려운 변형 — 점수가 1.0이 아니어야 정렬기를 제대로 잰다."""
    s = line.strip()
    out = []
    hangul = [i for i, c in enumerate(s) if "가" <= c <= "힣"]
    if hangul:
        i = rng.choice(hangul)
        out.append(("오타 1자", s[:i] + chr(ord(s[i]) + 28) + s[i + 1:]))
    words = s.split()
    if len(words) >= 5:
        j = rng.randrange(1, len(words) - 1)
        out.append(("단어 누락", " ".join(words[:j] + words[j + 1:])))
        out.append(("중간 삽입", " ".join(words[:j] + ["- 3 -"] + words[j:])))
    return out


def main() -> None:
    import rapidfuzz  # 기준값은 반드시 실제 rapidfuzz로 만든다

    rng = random.Random(7)
    cases = []
    for name, doc in DOCS.items():
        lines = [l for l in doc.split("\n") if len(l.strip()) >= 15 and len(fold(l)) >= 8]
        for line in lines:
            start = doc.index(line)
            for kind, q in _variants(line) + _hard_variants(line, rng):
                fq, _ = fold_with_map(q)
                fs, _ = fold_with_map(doc)
                score, _, _ = partial_ratio_alignment(fq, fs)
                r = align_quote(q, doc)
                cases.append({"doc": name, "kind": kind, "quote": q, "truth": True,
                              "lineStart": start, "lineEnd": start + len(line),
                              "score": round(score, 4), "start": r["start"], "end": r["end"]})
        others = [l for other, d in DOCS.items() if other != name
                  for l in d.split("\n") if len(l.strip()) >= 15]
        for q in rng.sample(others, 3) + FABRICATED:
            fq, _ = fold_with_map(q)
            fs, _ = fold_with_map(doc)
            score, _, _ = partial_ratio_alignment(fq, fs)
            cases.append({"doc": name, "kind": "환각", "quote": q, "truth": False,
                          "score": round(score, 4)})
    out = {"rapidfuzz": rapidfuzz.__version__, "docs": DOCS, "cases": cases}
    path = ROOT / "test" / "fixtures" / "align-rapidfuzz.json"
    path.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{len(cases)}건 → {path.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
