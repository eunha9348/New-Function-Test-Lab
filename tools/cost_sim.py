"""API를 호출하지 않고 '무엇이 얼마나 전송되는지'만 재서 비용을 비교한다.

Gemini를 스텁으로 갈아끼우고 파이프라인을 끝까지 돌린다.
토큰은 한국어 기준 대략 1토큰 ≈ 1.7자로 환산했다(추정치임을 명시).
"""
import importlib.util
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("arc", ROOT / "colab" / "arc_colab.py")
arc = importlib.util.module_from_spec(spec)
arc.__name__ = "arc"
sys.modules["arc"] = arc
spec.loader.exec_module(arc)

CHARS_PER_TOKEN = 1.7
DOC = (ROOT / "colab" / "sample_long.txt")


def make_doc(n_chars: int) -> str:
    """사용자 문서(31,033자)와 비슷한 분량의 한국어 기술문서를 만든다."""
    block = """
{i}. 시스템 구성과 설계 근거
역할이 분리된 7개 계층과 1개의 감독 에이전트로 구성된다. 검증·감사 계층은 9종이며
도메인 함정 규칙은 29종을 적용했다. 계산과 설명을 분리해 환각을 구조적으로 억제한다.
RAG 계층을 개선하여 상품분류 근거 확보율이 32.9%에서 55.7%로 올랐고,
시장잔고 확보율은 8.2%에서 12.0%로 개선되었다. Python 모듈 62개, 소스 코드 18,799행,
회귀 테스트 1,476건을 전량 통과시켰다. 팀명은 ADC이며 3인으로 구성되었다.
저는 백엔드 파트를 맡아 다중 에이전트 오케스트레이션을 설계했습니다.
한계는 재OCR을 통한 원문 복원을 포기한 점과 동시 요청 환경 검증이 없다는 점이다.
"""
    out = []
    i = 1
    while sum(len(x) for x in out) < n_chars:
        out.append(block.format(i=i))
        i += 1
    return "".join(out)[:n_chars]


class StubGemini(arc.Gemini):
    """호출 대신 페이로드 크기만 기록하고 그럴듯한 응답을 돌려준다."""

    def __init__(self):
        self.key = "stub"
        self.pin = ""
        self._models = ("gemini-3.8-flash", "gemini-3.8-flash")
        self._noth = set()
        self.usage = {"in": 0, "out": 0, "cost": 0.0, "calls": []}
        self.log: list = []

    def models(self):
        return self._models

    def generate(self, stage, parts, system, schema=None, max_tokens=32768,
                 thinking=-1, light=False, temperature=0.1):
        payload = len(system or "") + sum(len(p.get("text", "")) for p in parts)
        inline = sum(len(p["inline_data"]["data"]) for p in parts if "inline_data" in p)
        self.log.append({"stage": stage, "chars": payload, "inline_b64": inline,
                         "tier": "flash" if light else "pro"})
        return json.dumps(self._fake(stage, schema), ensure_ascii=False)

    def structured(self, stage, parts, system, schema, max_tokens=32768,
                   thinking=-1, light=False, temperature=0.1):
        self.generate(stage, parts, system, schema, max_tokens, thinking, light, temperature)
        return self._fake(stage, schema)

    def _fake(self, stage, schema):
        if stage == "ocr":
            return "텍스트"
        if stage == "factsheet":
            return {"docType": "보고서", "register": "격식체", "title": "연금 Agent",
                    "outline": [{"heading": "3. 시스템 구성", "summary": "7계층 구조"}],
                    "entities": {"orgs": ["ADC"], "tools": ["Python"], "people": [], "products": []},
                    "numbers": [{"value": "62", "unit": "개", "context": "Python 모듈",
                                 "before": None, "after": None}],
                    "dates": [], "myActions": ["백엔드 파트 설계"], "teamActions": [],
                    "unclear": [], "achievements": ["근거 확보율 32.9%→55.7%"],
                    "problems": ["동시성 검증 없음"], "learnings": [], "links": [],
                    "normalized": []}
        if stage == "classify":
            return {"categoryId": "project", "typeId": "project.team", "confidence": 0.95,
                    "rationale": "팀 프로젝트", "alternatives": [], "multipleExperiences": False}
        if stage == "extract":
            return {"values": {"projectName": "연금 Agent", "myRole": "백엔드 설계",
                               "workLogs": [{"name": "RAG 개선", "whatIDid": "근거 확보율 개선"}]},
                    "evidence": [{"path": "projectName", "sourceId": "src1",
                                  "quote": "팀명은 ADC이며", "confidence": 0.9}],
                    "unfilled": [{"path": "period", "reason": "원문에 없음"}]}
        if stage == "arbitrate":
            return {"decisions": []}
        if stage == "supervise":
            return {"verdict": "approve",
                    "scores": {"classification": 95, "coverage": 70,
                               "faithfulness": 92, "formatting": 100},
                    "issues": [], "reclassifyTo": None, "patch": [], "comment": ""}
        if stage == "guide":
            return {"missing": [], "recommendedUploads": [], "nextQuestions": []}
        return {}


def run(mode: str, doc: str):
    g = StubGemini()
    arc.Gemini = type("G", (), {})  # 파이프라인이 새로 만들지 못하게

    docs = [{"sourceId": "src1", "name": "기술제안서.pdf", "kind": "pdf",
             "text": doc, "confidence": 0.92, "warnings": []}]
    idx = arc.SourceIndex([doc])
    t = arc.TYPE_BY_ID["project.team"]
    fs = g.structured("factsheet", [{"text": arc.evidence_bundle(docs)}],
                      arc.FACTSHEET_SYSTEM, arc.FACTSHEET_SCHEMA, light=True)
    fs_text = arc.factsheet_text(fs)

    if mode == "old":
        # 기존: 분류(pro, 6k 발췌) + 배분×3(pro, 전문) + 감독×3(pro, 전문) + 안내(flash)
        g.log.clear()
        g.structured("classify", [{"text": doc[:6000]}], arc.CLASSIFY_SYSTEM,
                     arc.CLASSIFY_SCHEMA, light=False)
        for _ in range(3):
            arc.extract(g, t, docs, "", "", "", light=False)
            draft = {"values": {"projectName": "연금 Agent"},
                     "provenance": [{"path": "projectName", "confidence": .9,
                                     "quotes": [{"sourceId": "src1", "text": "팀명은 ADC이며"}]}],
                     "unfilled": []}
            arc.supervise(g, t, draft, docs, [], "", "")
        g.structured("guide", [{"text": doc[:2000]}], "guide", {"type": "OBJECT"}, light=True)
    else:
        g.log.clear()
        g.structured("factsheet", [{"text": arc.evidence_bundle(docs)}],
                     arc.FACTSHEET_SYSTEM, arc.FACTSHEET_SCHEMA, light=True)
        g.structured("classify", [{"text": doc[:6000]}], arc.CLASSIFY_SYSTEM,
                     arc.CLASSIFY_SCHEMA, light=True)
        for temp in (0.05, 0.35):
            arc.extract(g, t, docs, "", "", fs_text, temperature=temp, light=True)
        draft = {"values": {"projectName": "연금 Agent", "myRole": "백엔드 설계"},
                 "provenance": [{"path": "projectName", "confidence": .9,
                                 "quotes": [{"sourceId": "src1", "text": "팀명은 ADC이며"}]}],
                 "unfilled": []}
        spans = arc.evidence_spans(docs, draft["values"], draft["provenance"], idx)
        arc.supervise(g, t, draft, docs, [], spans, fs_text)
        g.structured("guide", [{"text": doc[:2000]}], "guide", {"type": "OBJECT"}, light=True)

    cost = 0.0
    per_tier = {"pro": 0, "flash": 0}
    for c in g.log:
        tok_in = (c["chars"] + c["inline_b64"] * 0.75) / CHARS_PER_TOKEN
        tok_out = 2500 if c["stage"] in ("extract", "supervise", "factsheet") else 700
        rate = arc.PRICE_PRO if c["tier"] == "pro" else arc.PRICE_FLASH
        cost += tok_in / 1e6 * rate[0] + tok_out / 1e6 * rate[1]
        per_tier[c["tier"]] += int(tok_in)
    return {"calls": len(g.log), "cost": cost, "tokens": per_tier, "log": g.log}


if __name__ == "__main__":
    doc = make_doc(31_033)          # 사용자가 올린 기술제안서와 같은 분량
    print(f"문서 분량: {len(doc):,}자 (사용자 실행과 동일)\n")
    old = run("old", doc)
    new = run("new", doc)
    print(f"{'':10s} {'호출':>4s} {'pro 토큰':>10s} {'flash 토큰':>11s} {'추정 비용':>10s}")
    for name, r in (("기존", old), ("개선", new)):
        print(f"{name:10s} {r['calls']:>4d} {r['tokens']['pro']:>10,} "
              f"{r['tokens']['flash']:>11,} {'$' + format(r['cost'], '.4f'):>10s}")
    print(f"\n절감률: {(1 - new['cost'] / old['cost']) * 100:.0f}%  "
          f"(${old['cost']:.4f} → ${new['cost']:.4f})")
    print("\n단계별 전송량 (개선판)")
    for c in new["log"]:
        print(f"  {c['stage']:11s} {c['tier']:5s} {c['chars']:>8,}자")
