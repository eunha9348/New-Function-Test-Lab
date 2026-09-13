"""RAGKOR 벤치마크 — 기존 방식(exact match) 대비 개선폭을 잰다.

평가셋은 실제 실패에서 역설계했다. 사용자가 올린 기술제안서에서 감독이
'환각'으로 찍었던 인용문들의 변형 유형을 그대로 재현한다.
"""
import random
import re
import sys
from typing import List, Tuple

from .ground import SourceIndex
from .jamo import typo_variants
from .match import default_lexicon
from .normalize import fold

# ── 평가용 원문 (한국어 기술문서 / 메모 / 활동기록 3종) ────────────────────
DOCS = {
    "기술문서": """2.1 이 도메인이 어려운 이유
연금 질의는 일반적인 문서 QA와 세 가지 지점에서 다르다.
1. 틀린 답이 금전적 손해로 직결된다
2. 코퍼스 자체가 불완전하다
3. 금융 규제상 단정적 추천이 금지된다

3. 시스템 구성
역할이 분리된 7개 계층과 1개의 감독 에이전트로 구성된다.
검증·감사 계층은 9종, 도메인 함정 규칙은 29종을 적용했다.

| 항목 | 값 |
| :--- | :--- |
| Python 모듈 | 62개 |
| 소스 코드 | 18,799행 |
| 회귀 테스트 | 1,476건 |

RAG 계층을 개선하여 상품분류 근거 확보율이 32.9%에서 55.7%로 올랐다.
시장잔고 확보율은 8.2%에서 12.0%로 개선되었다.

11.1 현재의 한계
재OCR을 통한 원문 복원을 포기했다. 동시 요청 환경에서의 검증이 없다.""",

    "업무메모": """8/12 화
오늘 주문 API 손봄. N+1 때문에 응답이 820ms나 나왔는데
fetch join 걸고 레디스 캐시 붙여서 210ms로 줄임. 개꿀.
근데 캐시 무효화를 깜빡해서 재고 수량이 잠깐 틀어짐 -> 주문 이벤트에서 evict 하도록 픽스.
멘토님한테 코드리뷰 받음. 팀플 때보다 훨씬 빡셈.

8/23 목
배치 모니터링 대시보드 마무리. 슬랙 알림까지 붙임.
장애 인지가 40분 -> 5분 안쪽으로 줄었다고 함. 나름 임팩트 있었던 듯""",

    "활동기록": """제10회 미래에셋증권 AI Festival 참가 기록
팀명: ADC (3인)
저는 백엔드 파트를 맡아 다중 에이전트 오케스트레이션을 설계했습니다.
예선 통과 후 본선에서 발표를 진행했고, 심사위원 질의응답까지 대응했습니다.
아쉬운 점은 동시성 테스트를 못 한 것입니다. 다음엔 부하 테스트를 먼저 하려 합니다.""",
}


def _old_check(quote: str, source: str) -> bool:
    """개선 전 검증기 — 정규화 후 exact substring."""
    n = lambda s: re.sub(r"[.,·:;'\"“”‘’()\[\]{}\-—_/\\|\s​]", "", str(s).replace("«불명»", "")).lower()
    nq = n(quote)
    return len(nq) < 8 or nq in n(source)


# ── 인용 변형 생성기 — 모델이 실제로 하는 변형만 넣는다 ──────────────────
def _variants(sentence: str) -> List[Tuple[str, str]]:
    s = sentence.strip()
    out = [("원문 그대로", s)]
    out.append(("말줄임표 절단", s[: max(12, int(len(s) * 0.7))] + "…"))
    out.append(("줄바꿈 합침", s.replace("\n", " ")))
    out.append(("문장부호 변형", s.replace(".", " ·").replace(",", " ")))
    out.append(("공백 재배치", re.sub(r"\s+", "", s)))
    out.append(("앞뒤 잘림", s[3:-3] if len(s) > 12 else s))
    return out


def build_eval() -> List[dict]:
    """(인용, 원문, 실제 근거 있음 여부) 평가 케이스."""
    cases: List[dict] = []
    rng = random.Random(42)

    # 표 구분선('| :--- |')처럼 정규화하면 내용이 남지 않는 줄은 문장이 아니므로 제외한다
    def is_sentence(line: str) -> bool:
        return len(line.strip()) >= 15 and len(fold(line)) >= 8

    for name, doc in DOCS.items():
        lines = [l.strip() for l in doc.split("\n") if is_sentence(l)]
        idx = SourceIndex([doc])
        for line in lines:
            for kind, q in _variants(line):
                cases.append({"doc": name, "kind": kind, "quote": q, "truth": True, "index": idx})
        # 진짜 환각 — 다른 문서의 문장, 그럴듯한 창작, 조각 긁어모으기
        others = [l.strip() for other, d in DOCS.items() if other != name
                  for l in d.split("\n") if is_sentence(l)]
        for l in rng.sample(others, min(6, len(others))):
            cases.append({"doc": name, "kind": "타 문서 문장", "quote": l.strip(),
                          "truth": False, "index": idx})
        fabricated = [
            "전국 대회에서 대상을 수상하여 상금 5천만원을 받았습니다",
            "누적 사용자 100만 명을 달성하여 업계 1위를 기록했습니다",
            "특허 3건을 출원하고 SCI 논문 2편을 게재했습니다",
            "연간 매출 15억 원 증대에 기여했습니다",
        ]
        for f in fabricated:
            cases.append({"doc": name, "kind": "창작", "quote": f, "truth": False, "index": idx})
        words = [w for l in lines for w in l.split()]
        for _ in range(4):
            frag = " ".join(rng.sample(words, min(9, len(words))))
            cases.append({"doc": name, "kind": "조각 긁어모음", "quote": frag,
                          "truth": False, "index": idx})
    return cases


def _prf(tp: int, fp: int, fn: int) -> Tuple[float, float, float]:
    p = tp / (tp + fp) if tp + fp else 0.0
    r = tp / (tp + fn) if tp + fn else 0.0
    f = 2 * p * r / (p + r) if p + r else 0.0
    return p, r, f


def run_grounding() -> dict:
    cases = build_eval()
    res = {}
    for label in ("기존(exact match)", "RAGKOR"):
        tp = fp = fn = tn = 0
        by_kind: dict = {}
        for c in cases:
            if label.startswith("기존"):
                ok = _old_check(c["quote"], "\n".join(DOCS.values()) if False else
                                DOCS[c["doc"]])
            else:
                ok = c["index"].verify_quote(c["quote"])["verdict"] != "ungrounded"
            truth = c["truth"]
            if truth and ok: tp += 1
            elif truth and not ok: fn += 1
            elif not truth and ok: fp += 1
            else: tn += 1
            k = by_kind.setdefault(c["kind"], [0, 0])
            k[1] += 1
            if ok == truth:
                k[0] += 1
        p, r, f = _prf(tp, fp, fn)
        res[label] = {"정밀도": round(p, 3), "재현율": round(r, 3), "F1": round(f, 3),
                      "정확도": round((tp + tn) / len(cases), 3),
                      "오탐(정상을 환각으로)": fn, "미탐(환각을 통과)": fp,
                      "총 케이스": len(cases),
                      "유형별": {k: f"{v[0]}/{v[1]}" for k, v in sorted(by_kind.items())}}
    return res


def run_typo() -> dict:
    """오타 복원율.

    사전에 이미 들어 있는 오타로 재면 순환 참조라 의미가 없다.
    그래서 **사전에 없는 오타만(held-out)** 골라 자모 유사도 폴백을 평가한다.
    사전 안에 있는 것들은 따로 세어 참고치로만 둔다.
    """
    lex = default_lexicon()
    words = ["프로젝트", "성과", "개선", "담당", "협업", "데이터", "사용자", "발표",
             "경험", "역할", "회사", "인턴", "동아리", "자격증", "포트폴리오",
             "커뮤니케이션", "리더십", "스프린트", "온보딩", "포지션"]
    in_dict = held_out = held_hit = 0
    misses: List[str] = []
    for w in words:
        target = lex.canonical(w)
        for t in typo_variants(w, limit=30):
            if t in lex.canon:
                in_dict += 1
                continue
            held_out += 1
            if lex.fuzzy_canonical(t)[0] == target:
                held_hit += 1
            elif len(misses) < 6:
                misses.append(f"{t}→{w}")
    return {"사전 수록 오타": in_dict,
            "미수록(held-out) 오타": held_out,
            "자모 유사도로 복원": held_hit,
            "held-out 복원율": round(held_hit / held_out, 3) if held_out else 0.0,
            "실패 예": misses}


def run_synonym() -> dict:
    """유의어·신조어를 같은 뜻으로 묶는 비율."""
    lex = default_lexicon()
    pairs = [("개선", "향상"), ("개선", "고도화"), ("감소", "절감"), ("감소", "단축"),
             ("성과", "실적"), ("성과", "아웃풋"), ("담당", "맡음"), ("주도", "리드"),
             ("협업", "콜라보"), ("문제", "이슈"), ("배포", "릴리스"), ("목표", "타깃"),
             ("갈아넣다", "집중투입하다"), ("캐리했다", "주도했다"), ("빡세다", "힘들다"),
             ("삽질", "시행착오"), ("팀플", "팀프로젝트"), ("취준", "취업준비"),
             ("컨텐츠", "콘텐츠"), ("메세지", "메시지"), ("리더쉽", "리더십"),
             ("퍼포먼스", "성능"), ("런칭", "출시"), ("데드라인", "마감기한")]
    hit = sum(1 for a, b in pairs if lex.canonical(a) == lex.canonical(b)
              or lex.canonical(b) in lex.expand(a) or lex.canonical(a) in lex.expand(b))
    return {"쌍": len(pairs), "일치": hit, "일치율": round(hit / len(pairs), 3),
            "실패": [f"{a}↔{b}" for a, b in pairs
                    if not (lex.canonical(a) == lex.canonical(b)
                            or lex.canonical(b) in lex.expand(a)
                            or lex.canonical(a) in lex.expand(b))]}


def run_known_limits() -> dict:
    """알려진 미탐 유형을 일부러 측정한다.

    RAGKOR는 '이 표현이 원문 어딘가에 있는가'만 본다. 원문 문장을 그대로 가져와
    **엉뚱한 항목에 붙인 경우**는 통과한다 — 설계상 그렇고, 숨기지 않고 수치로 남긴다.
    이건 감독 에이전트가 잡아야 할 몫이다.
    """
    idx = SourceIndex([DOCS["기술문서"]])
    # 원문의 '한계' 섹션 문장을 '성과' 근거로 붙인 경우 — 문자열은 진짜다
    misplaced = "재OCR을 통한 원문 복원을 포기했다"
    r = idx.verify_quote(misplaced)
    return {"유형": "맥락 오배치 (원문 문장을 엉뚱한 항목에 붙임)",
            "인용": misplaced, "판정": r["verdict"], "점수": r["score"],
            "잡히는가": r["verdict"] == "ungrounded"}


def run_number() -> dict:
    idx = SourceIndex([DOCS["기술문서"]])
    cases = [("18,799", "literal"), ("18799", "literal"), ("62", "literal"),
             ("55.7", "literal"), ("22.8", "derived"), ("3.8", "derived"),
             ("1,476", "literal"), ("999", "unknown"), ("5000", "unknown")]
    hit = sum(1 for n, exp in cases if idx.classify_number(n) == exp)
    return {"케이스": len(cases), "정확": hit, "정확도": round(hit / len(cases), 3),
            "판정": {n: idx.classify_number(n) for n, _ in cases}}


def main():
    lex = default_lexicon()
    print("=" * 70)
    print("  RAGKOR 벤치마크")
    print("=" * 70)
    print(f"\n[사전] 표면형 {lex.entries:,}개 / 의미 클러스터 {len(lex.clusters)}개\n")

    print("[1] 근거 검증 (환각 탐지)")
    g = run_grounding()
    for label, m in g.items():
        print(f"  {label}")
        print(f"    정밀도 {m['정밀도']:.3f} · 재현율 {m['재현율']:.3f} · F1 {m['F1']:.3f} "
              f"· 정확도 {m['정확도']:.3f}")
        print(f"    정상을 환각으로 오탐 {m['오탐(정상을 환각으로)']}건 / "
              f"환각을 통과시킴 {m['미탐(환각을 통과)']}건  (총 {m['총 케이스']})")
    print("\n    변형 유형별 정답률 (RAGKOR)")
    for k, v in g["RAGKOR"]["유형별"].items():
        old = g["기존(exact match)"]["유형별"][k]
        print(f"      {k:14s} 기존 {old:>7s} → RAGKOR {v:>7s}")

    print("\n[2] 오타 복원")
    t = run_typo()
    print(f"  사전 수록 {t['사전 수록 오타']}건 (참고치)")
    print(f"  사전에 없는 오타 {t['미수록(held-out) 오타']}건 중 자모 유사도로 "
          f"{t['자모 유사도로 복원']}건 복원 → {t['held-out 복원율']:.3f}")
    if t["실패 예"]:
        print(f"  실패 예: {', '.join(t['실패 예'])}")

    print("\n[3] 유의어·신조어 인식")
    sy = run_synonym()
    print(f"  {sy['쌍']}쌍 중 {sy['일치']}쌍 일치 → {sy['일치율']:.3f}")
    if sy["실패"]:
        print(f"  실패: {', '.join(sy['실패'])}")

    print("\n[4] 알려진 미탐 유형 (설계상의 한계)")
    kl = run_known_limits()
    print(f"  {kl['유형']}")
    print(f"    \"{kl['인용']}\" → {kl['판정']} ({kl['점수']}) · "
          f"{'잡힘' if kl['잡히는가'] else '통과함 — 감독 에이전트가 잡아야 하는 몫'}")

    print("\n[5] 수치 근거 판정 (원문값 / 파생값 / 근거없음)")
    n = run_number()
    print(f"  {n['케이스']}건 중 {n['정확']}건 정확 → {n['정확도']:.3f}")
    print(f"  {n['판정']}")
    print()
    return {"lexicon": lex.entries, "grounding": g, "typo": t, "synonym": sy,
            "number": n, "known_limits": kl}


if __name__ == "__main__":
    main()
