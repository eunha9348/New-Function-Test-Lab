# ==============================================================================
#  ARC 경험 자동 정리 — Colab 단일 파일 테스트본
# ------------------------------------------------------------------------------
#  파일을 올리면 → ① 경험 유형(대분류 4 / 세부 18종) 판별
#                → ② 유형별 입력 항목에 요약해서 배분
#                → ③ 감독 에이전트가 원문과 대조해 검수·수정
#                → ④ 못 채운 칸은 비우고 "무엇을 주면 채워지는지" 안내
#  실행: 이 셀을 그대로 붙여넣고 ▶ 누르면 됩니다. (Google API 키만 있으면 됨)
# ==============================================================================

GOOGLE_API_KEY = ""  #@param {type:"string"}
# ↑ https://aistudio.google.com/apikey 에서 발급한 키를 넣으세요 (AIza... 로 시작)

GEMINI_MODEL = ""  #@param {type:"string"}
# ↑ 비워두면 사용 가능한 최신 모델을 자동으로 고릅니다. 고정하려면 예: gemini-2.5-pro

import base64, io, json, os, re, sys, time, zipfile, mimetypes, textwrap
from collections import Counter, defaultdict
from datetime import datetime, timezone
import math, random, unicodedata
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

try:
    import requests
except ImportError:
    os.system(f"{sys.executable} -m pip install -q requests")
    import requests

# 위 칸을 비워 두고 환경변수로 넣어도 됩니다:  os.environ["GOOGLE_API_KEY"] = "AIza..."
GOOGLE_API_KEY = (GOOGLE_API_KEY or os.environ.get("GOOGLE_API_KEY", "")).strip()
GEMINI_MODEL = (GEMINI_MODEL or os.environ.get("GEMINI_MODEL", "")).strip()

API = "https://generativelanguage.googleapis.com/v1beta"
# (입력, 출력) USD / 1M tokens — 요금제에 맞게 조정하세요
PRICE_PRO = (1.25, 10.0)
PRICE_FLASH = (0.30, 2.50)

# ==============================================================================
#  RAGKOR — 한국어 어휘 자원 + 자모 유사도 매처
#  ragkor/ 패키지를 tools/pack_colab.py 가 기계적으로 합친 것. 별도 설치 불필요.
# ==============================================================================
# <<<RAGKOR_EMBED_START>>>

# ─────────────── ragkor/jamo.py ───────────────
"""한글 자모 처리 — RAGKOR의 오타 내성은 전부 여기서 나온다.

한국어 오타는 글자 단위로 재면 거리가 과장된다.
  '개선' vs '게선' → 글자 거리 1 (한 글자가 통째로 다름)
  자모로 펴면      ㄱㅐㅅㅓㄴ vs ㄱㅔㅅㅓㄴ → 거리 1/5 (모음 하나만 다름)
그래서 모든 유사도 계산을 자모 레벨에서 한다.
"""

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

# ─────────────── ragkor/normalize.py ───────────────
"""표기 정규화 — 같은 말을 같은 모양으로 만든다.

근거 검증이 무너지는 이유는 대부분 '의미'가 아니라 '표기'다.
말줄임표 하나, 표 파이프 하나, OCR이 끼워 넣은 페이지 머리말 하나로
exact match가 실패한다. 여기서 그 노이즈를 전부 걷어낸다.
"""

# ── 조사 — 길이 긴 것부터 벗겨야 '에서는'이 '에'로 잘못 잘리지 않는다 ──────
PARTICLES = sorted([
    "이라고는", "이라고", "라고는", "이라는", "라는", "으로서", "으로써", "로서", "로써",
    "에서는", "에게서", "한테서", "에서도", "에서의", "으로의", "에게는", "한테는",
    "에서", "에게", "한테", "으로", "께서", "부터", "까지", "처럼", "보다", "마다",
    "조차", "마저", "밖에", "이나", "나마", "라도", "이든", "든지", "이란", "이며",
    "이고", "과의", "와의", "의", "은", "는", "이", "가", "을", "를", "에", "로",
    "와", "과", "도", "만", "께", "야", "아", "여", "랑", "이랑",
], key=len, reverse=True)

# ── 용언 어미 — '개선했습니다/개선하여/개선함' 을 모두 '개선하' 로 ──────────
ENDINGS = sorted([
    "하였습니다", "했었습니다", "하겠습니다", "합니다", "했습니다", "됩니다", "되었습니다",
    "하였으며", "하였고", "하였다", "하였음", "했으며", "했었다", "하면서", "하도록",
    "시켰다", "시키는", "시킨", "되었다", "되었으며", "되어야", "되었고", "되는", "되어",
    "스러운", "스럽게", "스럽다", "롭게", "로운", "롭다",
    "했다", "한다", "하는", "하여", "하고", "해서", "해야", "했던", "하던", "하지",
    "하기", "하며", "할", "함", "됨", "된", "될", "돼", "됐다", "됐음",
    "습니다", "았다", "었다", "이다", "였다", "임", "음", "기",
], key=len, reverse=True)

# 문서 구조 노이즈 — OCR/마크다운이 끼워 넣는 것들
_MD_TABLE = re.compile(r"\|[\s:\-]*\|")
_MD_RULE = re.compile(r"^\s*[-=*_]{3,}\s*$", re.M)
_MD_MARK = re.compile(r"[|*_`~>#]")
_BULLET = re.compile(r"^[\s]*(?:[-•◦▪▶■●○◆□※·]|\d{1,2}[.)]|[가-힣][.)]|\([0-9가-힣]+\))\s*", re.M)
_PAGE = re.compile(r"^\s*[-—–]?\s*\d{1,3}\s*[-—–]?\s*$", re.M)          # 페이지 번호 줄
_PAGEMARK = re.compile(r"(?:page|페이지|쪽)\s*\d+\s*(?:/\s*\d+)?", re.I)
_UNCERTAIN = re.compile(r"«불명»|\[손글씨\]|\[\[NO_TEXT\]\]")
_PUNCT = re.compile(
    r"[.,·:;'\"“”‘’()\[\]{}\-—–_/\\|…‥~〜!?·､、。「」『』《》〈〉【】＜＞%％&@+＋*^°℃㎡№¶§†‡→←↔⇒⇔▲▼◀▶]"
)

_SPACE = re.compile(r"[\s\u200b\u00a0\ufeff]+")
_TOKEN = re.compile(r"[가-힣]+|[A-Za-z][A-Za-z0-9+#.]*|\d[\d,.]*")


def clean(text: str) -> str:
    """사람이 읽을 수 있는 형태는 유지하면서 구조 노이즈만 제거."""
    s = unicodedata.normalize("NFKC", text or "")
    s = _UNCERTAIN.sub(" ", s)
    s = _PAGE.sub("", s)
    s = _PAGEMARK.sub(" ", s)
    s = _MD_RULE.sub("", s)
    s = _MD_TABLE.sub(" ", s)
    s = _BULLET.sub("", s)
    s = re.sub(r"\n{3,}", "\n\n", s)
    return s.strip()


def fold(text: str) -> str:
    """비교 전용 — 구두점·공백·대소문자를 전부 날린 '뼈대'만 남긴다."""
    s = clean(text)
    s = _MD_MARK.sub("", s)
    s = _PUNCT.sub("", s)
    s = _SPACE.sub("", s)
    return s.lower()


def strip_particle(token: str) -> str:
    """명사에서 조사를 떼어낸다. 2글자 이하는 건드리지 않는다(오히려 망가진다)."""
    if len(token) <= 2:
        return token
    for p in PARTICLES:
        if token.endswith(p) and len(token) - len(p) >= 2:
            return token[: -len(p)]
    return token


def stem(token: str) -> str:
    """용언 어미를 정규화한다. '개선했습니다' → '개선'."""
    t = token
    for _ in range(2):                       # 어미가 겹쳐 붙는 경우 대비
        changed = False
        for e in ENDINGS:
            if t.endswith(e) and len(t) - len(e) >= 2:
                t = t[: -len(e)]
                changed = True
                break
        if not changed:
            break
    return t


def normalize_token(token: str) -> str:
    t = token.strip().lower()
    if not t:
        return ""
    if re.fullmatch(r"\d[\d,.]*", t):
        return normalize_number(t)
    if re.fullmatch(r"[가-힣]+", t):
        return stem(strip_particle(t))
    return t.rstrip(".")


_UNIT = {"천": 1_000, "만": 10_000, "억": 100_000_000, "조": 1_000_000_000_000}


def normalize_number(raw: str) -> str:
    """'18,799' '18799' '1만 8799' 를 같은 값으로 본다. 비교 실패의 단골 원인."""
    s = str(raw).strip().replace(",", "").replace(" ", "")
    m = re.fullmatch(r"(\d+(?:\.\d+)?)([천만억조])?", s)
    if not m:
        return s
    value = float(m.group(1))
    if m.group(2):
        value *= _UNIT[m.group(2)]
    return str(int(value)) if value == int(value) else str(value)


def numbers_in(text: str) -> Set[str]:
    """텍스트 안의 모든 수치를 정규화해서 모은다 (단위 표기 변형 포함)."""
    out: Set[str] = set()
    for m in re.finditer(r"(\d[\d,]*(?:\.\d+)?)\s*([천만억조])?", text or ""):
        out.add(normalize_number(m.group(1) + (m.group(2) or "")))
        out.add(normalize_number(m.group(1)))
    return out


def tokenize(text: str, drop_stopwords: bool = True) -> List[str]:
    out = []
    for m in _TOKEN.finditer(clean(text)):
        t = normalize_token(m.group())
        if not t or (drop_stopwords and t in STOPWORDS):
            continue
        if len(t) == 1 and re.fullmatch(r"[가-힣]", t):
            continue                          # 한 글자 한글은 노이즈가 많다
        out.append(t)
    return out


STOPWORDS = {
    "그리고", "그러나", "하지만", "또한", "그래서", "따라서", "및", "등", "등등", "이런",
    "그런", "저런", "이것", "그것", "저것", "여기", "거기", "저기", "때문", "위해", "통해",
    "대한", "관련", "경우", "정도", "수준", "부분", "내용", "사항", "다음", "이상", "이하",
    "있다", "없다", "같다", "되다", "하다", "이다", "아니", "것이", "것을", "수가", "우리",
    "저희", "자신", "본인", "해당", "각각", "모두", "전체", "일부", "매우", "가장", "정말",
}


def sentences(text: str) -> List[str]:
    """문장 분리 — 숫자 소수점을 문장 끝으로 오인하지 않는다."""
    s = clean(text)
    parts = re.split(r"(?<=[.!?。])\s+|\n+", s)
    return [p.strip() for p in parts if len(p.strip()) >= 2]


def ngrams(text: str, n: int = 4) -> List[str]:
    f = fold(text)
    if len(f) < n:
        return [f] if f else []
    return [f[i:i + n] for i in range(len(f) - n + 1)]

# ─────────────── ragkor/seed.py ───────────────
"""RAGKOR 시드 — 규칙 확장의 출발점.

여기 있는 것만 사람이 쓰고, 나머지 1만 건은 build_lexicon.py가 규칙으로 불린다.
선정 기준은 하나다: **경험 기록 문서에서 실제로 같은 뜻으로 갈려 쓰이는 말.**
사전에 있는 유의어가 아니라, 사용자가 올리는 글에서 부딪히는 표기 흔들림을 담았다.
"""

# ══════════════════════════════════════════════════════════════════════
#  1. 의미 클러스터 — 한 줄이 곧 '서로 바꿔 써도 되는 말 묶음'
#     맨 앞이 대표형(canon). 도메인 태그는 검색 가중치에 쓰인다.
# ══════════════════════════════════════════════════════════════════════
SEED_CLUSTERS = [
    # ── 성과·결과 (핵심 성과 추출이 가장 많이 실패하는 구간) ──────────────
    ("성과", "성과 결과 실적 산출물 아웃풋 결실 소득 성적 임팩트 효과", "성과"),
    ("개선", "개선 향상 제고 증진 높임 끌어올림 업그레이드 고도화 최적화 개량 보완 강화", "성과"),
    ("감소", "감소 절감 단축 줄임 축소 저감 낮춤 경감 다운 절약 세이브", "성과"),
    ("증가", "증가 상승 확대 늘림 신장 성장 급증 개선 증대 업 스케일업", "성과"),
    ("달성", "달성 도달 성취 이룸 완수 충족 만족 클리어 히트", "성과"),
    ("해결", "해결 처리 해소 조치 대응 수습 타개 픽스 트러블슈팅", "성과"),
    ("기여", "기여 공헌 이바지 보탬 도움 역할 몫 지분", "성과"),
    ("수상", "수상 입상 선정 당선 채택 우승 입선 어워드 수여", "성과"),
    ("인정", "인정 호평 칭찬 평가 피드백 반응 리뷰 평판", "성과"),
    ("지표", "지표 수치 메트릭 KPI 측정값 계량 통계 데이터", "성과"),
    ("전환율", "전환율 컨버전 CVR 전환 성사율", "성과"),
    ("응답시간", "응답시간 레이턴시 지연시간 latency 응답속도 처리시간", "성과"),
    ("처리량", "처리량 스루풋 throughput 처리속도 TPS QPS", "성과"),
    ("정확도", "정확도 정확률 accuracy 적중률 정밀도 신뢰도", "성과"),
    ("매출", "매출 수익 매상 세일즈 레비뉴 판매액 거래액 GMV", "성과"),
    ("비용", "비용 원가 코스트 지출 경비 예산 단가", "성과"),

    # ── 역할·기여 ('내 역할'과 '팀 성과'를 가르는 말들) ───────────────────
    ("담당", "담당 맡음 전담 수행 책임 주관 관장 도맡음 핸들링", "역할"),
    ("주도", "주도 리드 이끔 총괄 견인 드라이브 진두지휘 오너십", "역할"),
    ("참여", "참여 참가 합류 동참 가담 서포트 조인", "역할"),
    ("보조", "보조 지원 서포트 어시스트 도움 백업 헬프", "역할"),
    ("협업", "협업 협력 공동작업 코워크 콜라보 팀워크 제휴 연계", "역할"),
    ("소통", "소통 커뮤니케이션 의사소통 대화 논의 싱크 얼라인 조율", "역할"),
    ("조율", "조율 중재 합의 타협 조정 얼라인 정렬 컨센서스", "역할"),
    ("기획", "기획 설계 구상 플래닝 입안 디자인 청사진", "역할"),
    ("개발", "개발 구현 제작 빌드 구축 만듦 개발업무 코딩", "역할"),
    ("운영", "운영 관리 유지보수 오퍼레이션 운용 메인터넌스 관제", "역할"),
    ("분석", "분석 해석 진단 파악 리서치 조사 검토 스터디", "역할"),
    ("발표", "발표 프레젠테이션 PT 브리핑 공유 데모 시연 설명회", "역할"),
    ("교육", "교육 강의 멘토링 코칭 트레이닝 지도 온보딩 튜터링", "역할"),
    ("검증", "검증 테스트 확인 점검 검사 QA 밸리데이션 크로스체크", "역할"),
    ("리뷰", "리뷰 검토 피드백 코드리뷰 심사 평가 첨삭", "역할"),

    # ── 문제·어려움 (회고·트러블슈팅 구간) ──────────────────────────────
    ("문제", "문제 이슈 과제 난점 애로 트러블 결함 버그 장애 리스크", "문제"),
    ("한계", "한계 제약 제한 바운더리 리밋 걸림돌 병목 보틀넥", "문제"),
    ("실패", "실패 미달 부진 좌절 실수 삽질 헛발질 시행착오", "문제"),
    ("갈등", "갈등 의견차 마찰 대립 충돌 이견 불화", "문제"),
    ("원인", "원인 이유 근본원인 루트코즈 배경 사유 요인", "문제"),
    ("대응", "대응 조치 처치 핸들링 대처 액션 후속조치", "문제"),
    ("예방", "예방 방지 차단 사전대응 방어 리스크관리 헷지", "문제"),

    # ── 학습·성장 ─────────────────────────────────────────────────
    ("학습", "학습 공부 습득 익힘 배움 러닝 스터디 연마", "성장"),
    ("배운점", "배운점 교훈 인사이트 깨달음 레슨런 시사점 느낀점", "성장"),
    ("회고", "회고 돌아봄 리뷰 레트로 리트로스펙티브 복기 성찰", "성장"),
    ("동기", "동기 계기 이유 목적 지원동기 배경 취지 왜", "성장"),
    ("목표", "목표 타깃 골 지향점 방향 오브젝티브 과녁", "성장"),
    ("계획", "계획 플랜 로드맵 일정 스케줄 방안 전략 설계", "성장"),
    ("성장", "성장 발전 향상 도약 레벨업 스케일업 진일보", "성장"),

    # ── 조직·소속 ─────────────────────────────────────────────────
    ("회사", "회사 기업 직장 사업체 법인 조직 소속사 업체", "소속"),
    ("팀", "팀 조직 부서 파트 그룹 스쿼드 셀 유닛 챕터", "소속"),
    ("동아리", "동아리 소모임 클럽 서클 모임 학회 단체", "소속"),
    ("학교", "학교 대학 대학교 학부 캠퍼스 모교", "소속"),
    ("전공", "전공 학과 과 메이저 학부 계열", "소속"),
    ("직무", "직무 업무 포지션 롤 직능 일 담당업무 잡", "소속"),
    ("직책", "직책 직급 직위 타이틀 보직 포지션", "소속"),
    ("인턴", "인턴 인턴십 실습 현장실습 수습 견습", "소속"),

    # ── 기간·시점 ─────────────────────────────────────────────────
    ("기간", "기간 시기 동안 기한 텀 듀레이션 재직기간 수행기간", "기간"),
    ("시작", "시작 착수 개시 출발 킥오프 스타트 입사", "기간"),
    ("종료", "종료 마무리 완료 끝 마감 클로징 종료일 퇴사", "기간"),
    ("진행중", "진행중 재직중 수행중 현재 ongoing 계속 진행", "기간"),
    ("마감", "마감 데드라인 기한 납기 듀데이트 마감일 마감기한", "기간"),

    # ── 기술·도구 ─────────────────────────────────────────────────
    ("도구", "도구 툴 수단 기술 스택 소프트웨어 솔루션 프로그램", "기술"),
    ("서버", "서버 백엔드 백앤드 서버사이드 API서버", "기술"),
    ("화면", "화면 프론트엔드 프론트 UI 인터페이스 뷰 클라이언트", "기술"),
    ("데이터베이스", "데이터베이스 DB 디비 저장소 데이터스토어", "기술"),
    ("출시", "출시 런칭 론칭 배포 릴리스 릴리즈 디플로이 deploy 반영 오픈", "기술"),
    ("저장소", "저장소 리포지토리 레포 깃허브 repo repository", "기술"),
    ("문서", "문서 자료 도큐먼트 산출물 보고서 리포트 페이퍼 제안서", "기술"),
    ("모델", "모델 알고리즘 엔진 네트워크 아키텍처 구조", "기술"),
    ("자동화", "자동화 오토메이션 스크립트화 무인화 자동처리", "기술"),

    # ── 봉사·대외 ─────────────────────────────────────────────────
    ("봉사", "봉사 자원봉사 재능기부 나눔 사회공헌 볼런티어", "봉사"),
    ("수혜자", "수혜자 대상자 참여자 이용자 대상 클라이언트", "봉사"),
    ("주최", "주최 주관 운영 개최 호스트 기획사 운영사무국", "대외"),
    ("공모전", "공모전 경진대회 대회 콘테스트 챌린지 해커톤 컴피티션", "대외"),
    ("자격증", "자격증 라이선스 인증 면허 서티 certificate 증명서", "대외"),
]

# ══════════════════════════════════════════════════════════════════════
#  2. 표기 변이 — '틀린 표기 → 표준 표기'. 문서에서 압도적으로 자주 본다.
# ══════════════════════════════════════════════════════════════════════
SPELLING_VARIANTS = {
    "컨텐츠": "콘텐츠", "컨텐트": "콘텐츠", "메세지": "메시지", "메쎄지": "메시지",
    "비지니스": "비즈니스", "비지네스": "비즈니스", "스케쥴": "스케줄", "스케줄링": "스케줄링",
    "리더쉽": "리더십", "멤버쉽": "멤버십", "파트너쉽": "파트너십", "오너쉽": "오너십",
    "악세사리": "액세서리", "악세서리": "액세서리", "네비게이션": "내비게이션",
    "레퍼런스": "레퍼런스", "래퍼런스": "레퍼런스", "레퍼러스": "레퍼런스",
    "페러다임": "패러다임", "파라다임": "패러다임", "시뮬레이숑": "시뮬레이션",
    "어플리케이션": "애플리케이션", "어플": "앱", "아이템": "아이템",
    "프로젝": "프로젝트", "프로적트": "프로젝트", "프로첵트": "프로젝트",
    "커뮤니케이숀": "커뮤니케이션", "커뮤니케션": "커뮤니케이션",
    "데이타": "데이터", "데이터베이스": "데이터베이스", "디비": "데이터베이스",
    "알고리듬": "알고리즘", "알고리증": "알고리즘",
    "인터페이스": "인터페이스", "인터페이수": "인터페이스",
    "퍼포먼스": "성능", "퍼포먼서": "성능", "퍼포먼트": "성능",
    "디플로이먼트": "출시",
    "포트폴리오": "포트폴리오", "포폴": "포트폴리오",
    "커리어": "경력", "캐리어": "경력", "커리큘럼": "교육과정",
    "매니지먼트": "관리", "매니징": "관리", "오퍼레이션": "운영",
    "아젠다": "안건", "어젠다": "안건", "얼라인": "정렬", "얼라이먼트": "정렬",
    "컨펌": "확인", "컨셉": "콘셉트", "컨셉트": "콘셉트",
    "노하우": "노하우", "노우하우": "노하우",
    "센터": "센터", "샌터": "센터", "웹싸이트": "웹사이트", "웹사이트": "웹사이트",
    "싸이즈": "사이즈", "싸이클": "사이클", "타겟": "타깃", "타게팅": "타기팅",
    "트랜드": "트렌드", "트렌디": "트렌드", "펙트": "팩트", "팩트": "팩트",
    "리스크": "위험", "리스트": "목록", "체크리스트": "점검표",
    "이슈": "문제", "버그": "결함", "에러": "오류", "얼럿": "알림",
    "되요": "돼요", "됬다": "됐다", "됀다": "된다", "안되": "안돼",
    "몇일": "며칠", "왠지": "웬지", "웬만하면": "웬만하면", "왠만하면": "웬만하면",
    "역활": "역할", "역할": "역할", "어떻해": "어떡해", "금새": "금세",
    "오랫만": "오랜만", "일일히": "일일이", "틈틈히": "틈틈이", "꼼꼼히": "꼼꼼히",
    "설겆이": "설거지", "바램": "바람", "괜춘": "괜찮음", "낳다": "낫다",
    "들어나다": "드러나다", "맞추다": "맞히다", "가르키다": "가리키다",
    "어의없다": "어이없다", "구지": "굳이", "뭔가": "무언가", "쫌": "좀",
}

# ══════════════════════════════════════════════════════════════════════
#  3. 신조어·커뮤니티·업무체 — 메모장에 쓰인 말을 문서어로 잇는다.
#     이게 없으면 "갈아넣었다", "캐리했다" 같은 표현에서 성과를 못 읽는다.
# ══════════════════════════════════════════════════════════════════════
NEOLOGISMS = {
    # 커뮤니티/일상
    "갓생": "성실한 생활", "갓성비": "가성비", "가성비": "비용대비효과",
    "존버": "버티기", "존버했다": "버텼다", "갈아넣다": "집중투입하다",
    "캐리": "주도", "캐리했다": "주도했다", "하드캐리": "주도",
    "빡세다": "힘들다", "빡셈": "힘듦", "빡쳤다": "화났다",
    "현타": "회의감", "현타왔다": "회의감이들었다", "멘붕": "혼란",
    "삽질": "시행착오", "삽질했다": "시행착오를겪었다", "노가다": "단순반복작업",
    "뻘짓": "헛수고", "헛발질": "실패", "쌩으로": "직접", "맨땅에헤딩": "맨손으로시작",
    "국룰": "통상관례", "찐": "진짜", "찐성과": "실제성과", "억텐": "과장된반응",
    "팩폭": "사실지적", "뼈때리는": "정확한", "일침": "지적",
    "손절": "중단", "손절했다": "중단했다", "런": "이탈", "튀었다": "이탈했다",
    "물어봄": "질문", "여쭤봄": "질문", "찍먹": "맛보기", "찍먹해봤다": "간단히시도했다",
    "뇌절": "과잉반복", "알잘딱": "알아서잘", "알잘딱깔센": "알아서잘처리",
    "킹받다": "화나다", "쌉가능": "충분히가능", "개이득": "큰이득", "이득": "이득",
    "고인물": "숙련자", "뉴비": "초보자", "쩐다": "뛰어나다", "오지다": "대단하다",
    "미쳤다": "뛰어나다", "지리다": "뛰어나다", "역대급": "최고수준",
    "가보자고": "추진하자", "ㅇㅈ": "인정", "ㄱㅇㄷ": "개이득", "ㅇㄱㄹㅇ": "이거레알",
    "레알": "진짜", "인정": "인정", "찐텐": "진심",
    # 학업/취업
    "취준": "취업준비", "취준생": "취업준비생", "인강": "인터넷강의",
    "과탑": "학과수석", "학고": "학사경고", "휴학": "휴학", "복학": "복학",
    "스펙": "역량", "스펙업": "역량강화", "자소서": "자기소개서",
    "면접": "면접", "면접관": "면접관", "탈락": "불합격", "합격": "합격",
    "꿀강": "좋은강의", "꿀팁": "유용한정보", "꿀잼": "재미있음", "노잼": "재미없음",
    "조별과제": "팀과제", "조퓨": "팀프로젝트", "팀플": "팀프로젝트",
    "발표자": "발표담당", "피피티": "프레젠테이션", "피티": "프레젠테이션",
    # 업무/스타트업
    "온보딩": "적응교육", "스프린트": "단기개발주기", "린하게": "효율적으로",
    "팔로업": "후속조치", "팔로우업": "후속조치", "싱크": "의견조율",
    "R&R": "역할분담", "알앤알": "역할분담", "티오": "정원",
    "리소스": "자원", "인력": "인력", "공수": "작업량", "맨먼스": "작업량",
    "일정": "일정",
    "백로그": "대기작업", "티켓": "작업항목", "스펙아웃": "범위제외",
    "MVP": "최소기능제품", "PoC": "개념검증", "POC": "개념검증",
    "드라이브": "추진", "드라이브걸다": "강하게추진하다", "푸시": "독려",
    "임팩트": "영향력", "인사이트": "통찰", "레버리지": "활용",
    "디테일": "세부사항", "그로스": "성장", "리텐션": "잔존율",
    "유저": "사용자", "고객사": "고객사", "클라": "클라이언트",
    "협의": "협의", "논의": "논의", "미팅": "회의", "회의록": "회의록",
    "야근": "초과근무", "밤샘": "철야", "주말출근": "휴일근무",
}

# ══════════════════════════════════════════════════════════════════════
#  4. 줄임말 — 문서에는 줄임말로, 폼에는 정식 명칭으로 들어가야 한다.
# ══════════════════════════════════════════════════════════════════════
ABBREVIATIONS = {
    "카톡": "카카오톡", "인스타": "인스타그램", "유튜브": "유튜브", "페북": "페이스북",
    "깃헙": "깃허브", "깃허브": "깃허브", "노션": "노션", "슬랙": "슬랙",
    "피그마": "피그마", "제플린": "제플린", "지라": "지라", "컨플": "컨플루언스",
    "파이썬": "파이썬", "자스": "자바스크립트", "타스": "타입스크립트",
    "리액트": "리액트", "넥스트": "넥스트js", "스프링": "스프링",
    "디비": "데이터베이스", "에이피아이": "API", "에러": "오류",
    "프론트": "프론트엔드", "백": "백엔드", "풀스택": "풀스택",
    "머신러닝": "머신러닝", "엠엘": "머신러닝", "딥러닝": "딥러닝",
    "엘엘엠": "LLM", "지피티": "GPT", "제미나이": "제미나이",
    "토익": "TOEIC", "토플": "TOEFL", "오픽": "OPIc", "텝스": "TEPS",
    "정처기": "정보처리기사", "컴활": "컴퓨터활용능력", "한국사": "한국사능력검정",
    "산기": "산업기사", "기사": "기사", "기능사": "기능사",
    "고대": "고려대학교", "연대": "연세대학교", "서울대": "서울대학교",
    "카이스트": "KAIST", "포항공대": "POSTECH", "지스트": "GIST",
    "서포터즈": "서포터즈", "기자단": "기자단", "앰버서더": "앰배서더",
    "대외활": "대외활동", "동방": "동아리방", "학회": "학회",
    "교환": "교환학생", "어학연수": "어학연수", "워홀": "워킹홀리데이",
}

# ══════════════════════════════════════════════════════════════════════
#  5. 오타를 유발하는 고빈도 도메인 용어 — 여기서 오타 변형을 생성한다.
# ══════════════════════════════════════════════════════════════════════
TYPO_SEEDS = [
    "프로젝트", "성과", "개선", "담당", "협업", "기획", "개발", "운영", "분석",
    "데이터", "서비스", "사용자", "고객", "기능", "설계", "구현", "테스트", "배포",
    "문제", "해결", "목표", "계획", "일정", "회의", "발표", "보고서", "제안서",
    "경험", "역할", "기여", "참여", "활동", "교육", "학습", "연구", "논문",
    "회사", "팀", "부서", "인턴", "직무", "동아리", "학교", "전공", "수업",
    "봉사", "수상", "자격증", "어학", "포트폴리오", "인사이트", "커뮤니케이션",
    "매출", "비용", "효율", "품질", "안정성", "신뢰도", "정확도", "속도",
]

# ─────────────── ragkor/build_lexicon.py ───────────────
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

# ─────────────── ragkor/match.py ───────────────
"""RAGKOR 매처 — 사전 + 자모 유사도 + BM25를 하나로 묶는다."""





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

# ─────────────── ragkor/ground.py ───────────────
"""근거 검증 — RAGKOR의 존재 이유.

기존 검증기는 `normalize(quote) in normalize(source)` 였다.
모델이 인용을 조금만 다듬으면(말줄임표, 표 재구성, 페이지 머리말 삽입)
전부 '환각'으로 튀었고, 그 오탐이 감독에게 흘러가 재작업을 유발했다.
여기서는 **n-gram 국소 밀도**로 "원문 어딘가에 이 말이 실제로 있는가"를 잰다.
"""


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

# <<<RAGKOR_EMBED_END>>>



def _pip(mod: str, pkg: str = ""):
    """필요할 때만 조용히 설치한다.

    선택 의존성이 깨져 있어도(네이티브 확장 충돌 등) 파이프라인은 살아야 하므로
    ImportError뿐 아니라 네이티브 패닉까지 삼킨다.
    """
    def _try():
        try:
            return __import__(mod)
        except (KeyboardInterrupt, SystemExit):
            raise
        except BaseException:
            return None
    got = _try()
    if got is not None:
        return got
    os.system(f"{sys.executable} -m pip install -q {pkg or mod}")
    return _try()


# ==============================================================================
#  1. 스키마 — 공통 항목 + 경험 유형 18종
# ==============================================================================

def F(key, label, kind, req=False, options=None, group=None, fields=None,
      supersedes=None, hint=None, free=False):
    d = {"key": key, "label": label, "kind": kind}
    if req: d["req"] = True
    if options: d["options"] = options
    if group: d["group"] = group
    if fields: d["fields"] = fields
    if supersedes: d["supersedes"] = supersedes
    if hint: d["hint"] = hint
    if free: d["free"] = True
    return d


def T(tid, cat, label, emoji, aliases, signals, fields):
    return {"id": tid, "category": cat, "label": label, "emoji": emoji,
            "aliases": aliases, "signals": signals, "fields": fields}


# ── 기본 정보 6종 (데이터 모델 공통. 화면에는 제목/요약·확장입력·증빙으로 흩어짐) ──
BASE_FIELDS = [
    F("title", "경험명", "text", req=True, hint="활동의 실제 이름. 파일명이 아님."),
    F("period", "기간", "daterange", req=True),
    F("summary", "한 줄 요약", "text", hint="80자 내외 한 문장."),
    F("myRole", "내 역할/기여도", "longtext", hint="'나'가 한 일만. 팀 성과와 구분."),
    F("keyAchievement", "핵심 성과", "longtext", hint="원문에 있는 수치만. 지어내지 말 것."),
    F("evidence", "증빙 자료", "file", hint="업로드된 파일명 그대로."),
]

# ── 확장 입력 8종 (화면에 보이는 유일한 공통 섹션, 기본 접힘) ──
EXTENDED_FIELDS = [
    F("background", "배경/목표", "longtext"),
    F("actions", "내가 한 행동", "longtext"),
    F("outcome", "결과/성과", "longtext"),
    F("learned", "배운 점", "longtext"),
    F("skills", "사용한 스킬", "tags"),
    F("team", "협업/팀", "text"),
    F("difficulty", "난이도", "select", options=["상", "중", "하"]),
    F("visibility", "공개 설정", "select", options=["공개", "비공개", "일부 공개"]),
]

HEADER_KEYS = ["title", "summary"]
EVIDENCE_KEYS = ["evidence"]

CATEGORIES = [
    {"id": "academic", "label": "학업", "emoji": "🎓",
     "signals": ["학교", "전공", "수업", "학점", "성적표", "학회", "동아리", "논문", "연구", "랩", "교수", "학기"]},
    {"id": "career", "label": "커리어", "emoji": "💼",
     "signals": ["회사", "인턴", "재직", "근무", "직무", "대외활동", "서포터즈", "수상", "공모전", "자격증", "어학"]},
    {"id": "project", "label": "프로젝트", "emoji": "🚀",
     "signals": ["프로젝트", "리포지토리", "배포", "README", "기획서", "포트폴리오", "작품", "디자인", "영상"]},
    {"id": "growth", "label": "개인성장", "emoji": "🌱",
     "signals": ["봉사", "해외", "교환학생", "운동", "훈련", "독서", "회고", "일지", "목표", "계획", "루틴"]},
]

EXPERIENCE_TYPES = [
    # ══════════════ 🎓 학업 ══════════════
    T("academic.major_course", "academic", "전공 및 수강 수업", "🎓",
      ["전공", "수강", "수업", "강의", "학점", "성적표"],
      ["성적증명서", "수강신청 내역", "강의계획서", "학기 성적", "교수님", "과제 제출물"], [
        F("schoolName", "학교명", "text", req=True, group="학교 정보"),
        F("major", "전공", "text", group="학교 정보"),
        F("enrollmentStatus", "재학/졸업 상태", "select", options=["재학중", "졸업", "휴학중", "졸업예정"], group="학교 정보"),
        F("admissionDate", "입학일", "date", group="학교 정보"),
        F("graduationDate", "졸업(예정)일", "date", group="학교 정보"),
        F("transcript", "전체 학기 성적표", "file", group="학교 정보"),
        F("courses", "수업 기록", "repeater", group="수업 기록",
          hint="수업 하나당 항목 1개. 과목이 여러 개면 전부 나눠서.", fields=[
            F("courseName", "수업명", "text", req=True),
            F("professor", "교수", "text"),
            F("department", "담당 전공 학과", "text"),
            F("semester", "수강 학기/연도", "text", req=True),
            F("grade", "취득 성적", "text"),
            F("courseSummary", "수업 요약", "longtext"),
            F("keyOutcome", "핵심 성과 기록", "longtext"),
            F("teamProject", "팀프로젝트/과제 내용", "longtext")]),
        F("careerImpact", "커리어에 준 영향", "tags", group="수업 기록"),
      ]),
    T("academic.society", "academic", "학회", "📚",
      ["학회", "학술단체", "학술동아리"], ["학회 활동 인증서", "학술대회", "세미나 발표", "학회장", "기수"], [
        F("societyName", "학회명", "text", req=True, group="학회 정보"),
        F("societyIntro", "학회 소개", "longtext", group="학회 정보"),
        F("officialUrl", "공식 URL/웹사이트", "link", group="학회 정보"),
        F("period", "기간", "daterange", req=True, group="학회 정보", supersedes=["period"]),
        F("certificate", "활동 인증서", "file", group="학회 정보"),
        F("motivation", "지원 동기", "longtext", group="학회 정보"),
        F("role", "역할/직책", "text", req=True, group="학회 정보", supersedes=["myRole"]),
        F("projects", "프로젝트/연구활동", "repeater", group="프로젝트/연구활동 기록", fields=[
            F("name", "프로젝트/연구활동명", "text", req=True),
            F("detailPeriod", "세부 기간", "text", req=True),
            F("role", "직책/역할", "text", req=True),
            F("goal", "연구/프로젝트 목표", "longtext"),
            F("whatIDid", "내가 한 일", "longtext"),
            F("keyOutcome", "핵심 성과", "longtext"),
            F("presentation", "발표/포스터/세미나 여부", "text"),
            F("feedback", "피드백/질문과 대응", "longtext")]),
      ]),
    T("academic.club", "academic", "동아리/교내 단체", "👥",
      ["동아리", "교내 단체", "학생회", "소모임"], ["동아리 활동 인증서", "총무", "회장", "운영진", "정기 모임"], [
        F("clubName", "동아리/단체명", "text", req=True, group="동아리/단체 정보"),
        F("clubIntro", "단체 소개", "longtext", group="동아리/단체 정보"),
        F("period", "기간", "daterange", req=True, group="동아리/단체 정보", supersedes=["period"]),
        F("certificate", "활동 인증서/수료 증빙", "file", group="동아리/단체 정보"),
        F("role", "직책/역할", "text", req=True, group="동아리/단체 정보", supersedes=["myRole"]),
        F("activities", "활동 기록", "repeater", group="활동 기록", fields=[
            F("activityName", "활동명", "text", req=True),
            F("detailPeriod", "세부 기간", "text"),
            F("role", "직책/역할", "text"),
            F("detail", "활동내용 상세", "longtext"),
            F("result", "행사/운영 성과", "longtext")]),
      ]),
    T("academic.research", "academic", "연구 경험/논문", "🔬",
      ["연구", "논문", "학부연구생", "RA", "랩", "저널"], ["초록", "Abstract", "실험 설계", "선행연구", "참고문헌", "게재"], [
        F("researchTitle", "연구 주제/논문 제목", "text", req=True, group="연구 정보"),
        F("affiliation", "소속/기관/랩", "text", group="연구 정보"),
        F("period", "기간", "daterange", req=True, group="연구 정보", supersedes=["period"]),
        F("role", "역할", "select", options=["주저자", "공저", "연구원", "RA", "기타"], group="연구 정보"),
        F("researchQuestion", "연구 질문/가설", "longtext", group="연구 정보"),
        F("method", "방법/설계", "longtext", group="연구 정보"),
        F("dataSource", "데이터/자료 출처", "text", group="연구 정보"),
        F("myPart", "내가 맡은 파트", "longtext", req=True, group="연구 정보", supersedes=["myRole"]),
        F("resultSummary", "결과 요약", "longtext", group="연구 정보"),
        F("achievements", "성과", "tags", group="연구 정보", supersedes=["keyAchievement"]),
        F("shareLink", "재현/공유 자료", "link", group="연구 정보"),
        F("references", "참고문헌/관련 읽을거리", "longtext", group="연구 정보"),
        F("artifacts", "산출물", "file", group="연구 정보", supersedes=["evidence"]),
      ]),
    # ══════════════ 💼 커리어 ══════════════
    T("career.work", "career", "인턴 및 업무 경력", "💼",
      ["인턴", "근무", "재직", "회사", "업무", "경력", "직무"],
      ["경력증명서", "재직증명서", "근로계약", "온보딩", "스프린트", "퇴사"], [
        F("companyName", "회사명", "text", req=True, group="근무 정보"),
        F("employmentPeriod", "재직기간", "daterange", req=True, group="근무 정보", supersedes=["period"]),
        F("employmentType", "고용 형태", "select", options=["인턴", "계약직", "정규직", "프리랜서"], group="근무 정보"),
        F("position", "직책/직급", "text", req=True, group="근무 정보"),
        F("jobFunction", "직무(업무분야)", "text", req=True, group="근무 정보"),
        F("salary", "급여", "text", group="근무 정보", hint="원문에 명시된 경우에만."),
        F("motivation", "지원 동기", "longtext", group="근무 정보"),
        F("team", "팀/조직", "text", group="근무 정보", supersedes=["team"]),
        F("workMode", "근무 형태", "select", options=["재택", "출근", "혼합"], group="근무 정보"),
        F("tasks", "업무내용", "repeater", group="업무내용 기록",
          hint="담당 프로젝트/업무 단위로 쪼갤 것. 한 문단으로 뭉치지 말 것.", fields=[
            F("name", "프로젝트/업무명", "text", req=True),
            F("detailPeriod", "세부 기간", "text"),
            F("role", "역할", "text", req=True),
            F("detail", "업무내용 상세", "longtext"),
            F("tools", "활용 툴", "text"),
            F("collaborators", "협업 대상", "text"),
            F("metrics", "성과 지표", "longtext"),
            F("risks", "리스크/이슈 및 대응", "longtext")]),
        F("resignReason", "퇴사 사유", "longtext", group="업무내용 기록"),
      ]),
    T("career.external", "career", "대외활동", "📣",
      ["대외활동", "서포터즈", "앰배서더", "기자단", "부트캠프", "멘토링"], ["활동 인증서", "위촉장", "미션 수행", "주최"], [
        F("activityName", "활동명", "text", req=True, group="활동 정보"),
        F("organizer", "주최/기관명", "text", group="활동 정보"),
        F("period", "기간", "daterange", req=True, group="활동 정보", supersedes=["period"]),
        F("certificate", "활동 인증서", "file", group="활동 정보"),
        F("role", "직책/역할", "text", req=True, group="활동 정보", supersedes=["myRole"]),
        F("motivation", "지원 동기", "longtext", group="활동 정보"),
        F("mission", "담당 업무/미션", "longtext", group="활동내용 상세"),
        F("whatIDid", "내가 한 일", "repeater", group="활동내용 상세",
          fields=[F("action", "행동", "longtext")]),
        F("collaboration", "협업/커뮤니케이션 방식", "longtext", group="활동내용 상세", supersedes=["team"]),
        F("results", "결과/성과", "repeater", group="활동내용 상세", supersedes=["keyAchievement", "outcome"], fields=[
            F("type", "성과 유형", "text"),
            F("value", "수치", "text", hint="원문에 있는 숫자만."),
            F("desc", "설명", "longtext")]),
        F("outputFile", "결과물/작업물", "file", group="활동내용 상세"),
        F("reference", "추천인/증언", "text", group="활동내용 상세"),
      ]),
    T("career.award", "career", "수상 경력", "🏆",
      ["수상", "공모전", "해커톤", "경진대회", "장학금"], ["상장", "대상", "최우수상", "우수상", "장려상", "심사평", "본선"], [
        F("awardName", "수상명", "text", req=True, group="수상 정보"),
        F("organizer", "주최/기관", "text", req=True, group="수상 정보"),
        F("awardDate", "수상일", "date", group="수상 정보"),
        F("competitionName", "대회/프로그램명", "text", group="수상 정보"),
        F("awardRank", "수상 구분", "select", options=["대상", "최우수", "우수", "장려", "기타"], group="수상 정보"),
        F("participationType", "참가 형태", "select", options=["개인", "팀"], group="수상 정보"),
        F("teamMembers", "팀명/팀원", "text", group="수상 정보", supersedes=["team"]),
        F("criteria", "평가 기준/요구사항", "longtext", group="수상 정보"),
        F("myContribution", "내 역할/기여", "longtext", req=True, group="수상 정보", supersedes=["myRole"]),
        F("submission", "제출물/발표 자료", "file", group="수상 정보"),
        F("awardEvidence", "수상 증빙", "file", group="수상 정보", supersedes=["evidence"]),
        F("keyAchievement", "핵심 성과", "longtext", group="수상 정보", supersedes=["keyAchievement"]),
        F("competencyTags", "이 수상이 의미하는 역량", "tags", group="수상 정보"),
      ]),
    T("career.certificate", "career", "보유 자격증", "✅",
      ["자격증", "면허", "인증", "기사", "컴활", "정보처리"], ["합격증", "자격증 번호", "발급기관", "취득일", "유효기간"], [
        F("certName", "자격증명", "text", req=True, group="자격증 정보"),
        F("issuer", "발급 기관", "text", req=True, group="자격증 정보"),
        F("acquiredDate", "취득일", "date", group="자격증 정보"),
        F("validity", "유효기간/갱신 필요 여부", "text", group="자격증 정보"),
        F("certNumber", "자격 번호", "text", group="자격증 정보"),
        F("gradeScore", "성적/등급", "text", group="자격증 정보"),
        F("prepPeriod", "준비 기간", "daterange", group="자격증 정보", supersedes=["period"]),
        F("studyMethod", "학습 방식", "select", options=["강의", "독학", "스터디", "부트캠프"], group="자격증 정보"),
        F("studyMaterials", "핵심 공부 자료", "link", group="자격증 정보"),
        F("applications", "실무 적용 사례", "repeater", group="실무 적용 사례", fields=[
            F("context", "적용 상황/프로젝트명", "text", req=True),
            F("whatIDid", "내가 한 일", "longtext"),
            F("effect", "결과/효과", "longtext")]),
        F("certEvidence", "자격증 증빙", "file", group="실무 적용 사례", supersedes=["evidence"]),
      ]),
    T("career.language", "career", "어학 능력", "🗣",
      ["어학", "토익", "토플", "OPIc", "JLPT", "HSK", "TOEIC"], ["성적표", "점수", "등급", "응시일", "유효기간"], [
        F("language", "언어", "text", req=True, group="어학 정보"),
        F("testName", "시험/인증명", "text", group="어학 정보"),
        F("score", "점수/등급", "text", group="어학 정보"),
        F("testDate", "응시일", "date", group="어학 정보"),
        F("validity", "유효기간", "text", group="어학 정보"),
        F("strengths", "강점 영역", "checklist", options=["듣기", "읽기", "말하기", "쓰기"], group="어학 정보"),
        F("studyPeriod", "학습 기간", "daterange", group="어학 정보", supersedes=["period"]),
        F("studyMethod", "학습 방식", "select", options=["학원", "독학", "회화", "첨삭", "스터디"], group="어학 정보"),
        F("usages", "활용 사례", "repeater", group="실제 활용 사례", fields=[
            F("situation", "상황", "text", req=True),
            F("myRole", "내가 한 역할", "longtext"),
            F("difficulty", "어려웠던 점과 해결", "longtext"),
            F("result", "결과", "longtext")]),
      ]),
    # ══════════════ 🚀 프로젝트 ══════════════
    T("project.personal", "project", "개인 프로젝트", "🚀",
      ["개인 프로젝트", "토이 프로젝트", "사이드 프로젝트", "1인 개발"], ["README", "커밋 로그", "배포 링크", "기술 스택"], [
        F("projectName", "프로젝트명", "text", req=True, group="프로젝트 정보"),
        F("period", "기간", "daterange", req=True, group="프로젝트 정보", supersedes=["period"]),
        F("oneLiner", "한 줄 설명", "text", req=True, group="프로젝트 정보", supersedes=["summary"]),
        F("goal", "목표/만들고 싶었던 이유", "longtext", group="프로젝트 정보", supersedes=["background"]),
        F("targetUser", "대상 사용자/사용 상황", "longtext", group="프로젝트 정보"),
        F("features", "주요 기능", "checklist", free=True, group="프로젝트 정보"),
        F("techStack", "기술/도구", "tags", group="프로젝트 정보", supersedes=["skills"]),
        F("decisions", "설계/결정", "repeater", group="설계/결정 기록", fields=[
            F("topic", "결정 주제", "text", req=True),
            F("alternatives", "대안 비교", "longtext"),
            F("reason", "선택 이유", "longtext"),
            F("resultLearned", "결과/배운 점", "longtext")]),
        F("outcome", "성과", "longtext", group="설계/결정 기록", supersedes=["keyAchievement", "outcome"]),
        F("demoLink", "데모/배포 링크", "link", group="설계/결정 기록"),
        F("repoLink", "저장소 링크", "link", group="설계/결정 기록"),
        F("screenshots", "스크린샷/영상", "file", group="설계/결정 기록"),
        F("nextPlan", "다음 개선 계획", "longtext", group="설계/결정 기록"),
      ]),
    T("project.team", "project", "팀 프로젝트", "👨‍👩‍👧‍👦",
      ["팀 프로젝트", "협업 프로젝트", "조별과제"], ["역할 분담", "스크럼", "PR 리뷰", "팀원", "회고", "일정 조율"], [
        F("projectName", "프로젝트명", "text", req=True, group="프로젝트 정보"),
        F("period", "기간", "daterange", req=True, group="프로젝트 정보", supersedes=["period"]),
        F("teamComposition", "팀 구성", "longtext", group="프로젝트 정보", supersedes=["team"]),
        F("myRole", "내 역할", "longtext", req=True, group="프로젝트 정보", supersedes=["myRole"]),
        F("problemDefinition", "목표/문제 정의", "longtext", group="프로젝트 정보", supersedes=["background"]),
        F("collaboration", "협업 방식", "longtext", group="프로젝트 정보"),
        F("roleMatrix", "역할 분담표", "longtext", group="프로젝트 정보"),
        F("workLogs", "작업 기록", "repeater", group="작업 기록",
          hint="'내가' 한 작업 단위로. 팀 전체 작업을 내 것으로 적지 말 것.", fields=[
            F("name", "작업/이슈명", "text", req=True),
            F("period", "기간", "text"),
            F("whatIDid", "내가 한 일", "longtext", req=True),
            F("result", "결과", "longtext")]),
        F("conflictResolution", "갈등/의견 차이와 조율", "longtext", group="작업 기록"),
        F("outputLink", "결과물 링크", "link", group="작업 기록"),
        F("retrospective", "회고 (잘된 점/아쉬운 점/다음엔)", "longtext", group="작업 기록", supersedes=["learned"]),
      ]),
    T("project.creative", "project", "창작물/작업물", "🎨",
      ["창작물", "작업물", "포트폴리오", "디자인", "영상", "음악", "사진"], ["작품", "레퍼런스", "컨셉", "스토리보드", "연재"], [
        F("workName", "작품/작업물명", "text", req=True, group="작품 정보"),
        F("field", "분야", "select", options=["디자인", "글", "영상", "음악", "사진", "일러스트", "기타"], group="작품 정보"),
        F("productionPeriod", "제작 기간", "daterange", group="작품 정보", supersedes=["period"]),
        F("oneLiner", "한 줄 소개", "text", req=True, group="작품 정보", supersedes=["summary"]),
        F("intent", "의도/주제", "longtext", group="작품 정보", supersedes=["background"]),
        F("tools", "사용 도구", "tags", group="작품 정보", supersedes=["skills"]),
        F("process", "제작 과정", "repeater", group="제작 과정", fields=[
            F("stage", "단계명", "text", req=True),
            F("whatIDid", "한 일", "longtext"),
            F("decisions", "고민/결정", "longtext"),
            F("result", "결과", "longtext")]),
        F("publicLink", "공개 링크", "link", group="제작 과정"),
        F("reception", "반응/성과", "longtext", group="제작 과정", supersedes=["outcome", "keyAchievement"]),
        F("copyright", "저작권/사용 범위", "text", group="제작 과정"),
      ]),
    # ══════════════ 🌱 개인성장 ══════════════
    T("growth.volunteer", "growth", "봉사활동", "❤️",
      ["봉사", "자원봉사", "재능기부", "나눔"], ["봉사 확인서", "1365", "VMS", "봉사시간", "복지관"], [
        F("volunteerName", "봉사활동명", "text", req=True, group="봉사 정보"),
        F("organization", "기관/장소", "text", group="봉사 정보"),
        F("period", "기간", "daterange", req=True, group="봉사 정보", supersedes=["period"]),
        F("totalHours", "총 시간", "text", group="봉사 정보"),
        F("target", "대상", "select", options=["아동", "노인", "동물", "환경", "기타"], group="봉사 정보"),
        F("activityType", "활동 형태", "select", options=["오프라인", "온라인", "기획", "현장"], group="봉사 정보"),
        F("myRole", "내 역할", "longtext", req=True, group="봉사 정보", supersedes=["myRole"]),
        F("activityDetail", "활동 내용", "longtext", group="봉사 정보"),
        F("impact", "임팩트/변화", "longtext", group="봉사 정보", supersedes=["outcome", "keyAchievement"]),
        F("reflection", "느낀 점/가치관 변화", "longtext", group="봉사 정보", supersedes=["learned"]),
        F("certificate", "봉사 확인서", "file", group="봉사 정보", supersedes=["evidence"]),
      ]),
    T("growth.overseas", "growth", "해외 경험", "🌍",
      ["해외", "교환학생", "어학연수", "워홀", "해외 인턴"], ["비자", "출입국", "현지", "홈스테이", "문화 차이"], [
        F("experienceType", "경험 유형", "select", options=["교환학생", "연수", "여행", "해외 인턴", "기타"], group="해외 경험 정보"),
        F("countryCity", "국가/도시", "text", req=True, group="해외 경험 정보"),
        F("period", "기간", "daterange", req=True, group="해외 경험 정보", supersedes=["period"]),
        F("purpose", "목적", "longtext", group="해외 경험 정보", supersedes=["background"]),
        F("activitySummary", "활동 요약", "longtext", req=True, group="해외 경험 정보"),
        F("languageLevel", "언어 사용 수준", "text", group="해외 경험 정보"),
        F("challenges", "어려웠던 상황", "repeater", group="어려웠던 상황", fields=[
            F("situation", "상황", "text", req=True),
            F("response", "내가 한 대응", "longtext"),
            F("result", "결과", "longtext"),
            F("learned", "배운 점", "longtext")]),
        F("outcome", "성과/산출물", "longtext", group="어려웠던 상황", supersedes=["outcome", "keyAchievement"]),
        F("evidence", "증빙", "file", group="어려웠던 상황", supersedes=["evidence"]),
      ]),
    T("growth.fitness", "growth", "운동 및 신체 역량", "🏃",
      ["운동", "헬스", "러닝", "마라톤", "클라이밍", "수영", "체력"], ["훈련 일지", "PB", "기록 단축", "인바디", "대회 참가"], [
        F("sport", "종목", "text", req=True, group="운동 정보"),
        F("period", "기간", "daterange", req=True, group="운동 정보", supersedes=["period"]),
        F("goal", "목표", "longtext", group="운동 정보", supersedes=["background"]),
        F("currentLevel", "현재 수준", "text", group="운동 정보"),
        F("trainingPlan", "훈련 계획", "text", group="운동 정보"),
        F("logs", "기록 로그", "repeater", group="기록 로그",
          hint="날짜별 로그. 원문에 날짜가 여러 개면 각각 분리.", fields=[
            F("date", "날짜", "date", req=True),
            F("content", "훈련 내용", "longtext", req=True),
            F("record", "기록", "text"),
            F("condition", "컨디션/메모", "longtext")]),
        F("competition", "대회/인증", "longtext", group="기록 로그"),
        F("change", "변화/성과", "longtext", group="기록 로그", supersedes=["outcome", "keyAchievement"]),
        F("consistencyEvidence", "꾸준함 증거", "file", group="기록 로그", supersedes=["evidence"]),
      ]),
    T("growth.reading", "growth", "독서", "📖",
      ["독서", "책", "완독", "서평", "독후감", "북클럽"], ["저자", "출판사", "챕터", "밑줄", "인용", "발췌"], [
        F("bookTitle", "도서명", "text", req=True, group="독서 정보"),
        F("author", "저자", "text", group="독서 정보"),
        F("readPeriod", "읽은 기간/완독일", "text", group="독서 정보", supersedes=["period"]),
        F("reason", "읽은 이유", "longtext", group="독서 정보", supersedes=["background"]),
        F("summary3", "핵심 요약 (3줄)", "longtext", req=True, group="독서 정보", hint="정확히 3줄."),
        F("quotes", "인상 깊은 문장", "longtext", group="독서 정보"),
        F("applications", "적용/실험", "repeater", group="적용/실험", fields=[
            F("topic", "적용할 주제", "text", req=True),
            F("action", "내가 한 행동", "longtext"),
            F("result", "결과/느낌 점", "longtext")]),
        F("relatedLink", "관련 자료", "link", group="적용/실험"),
        F("recommendTo", "추천 대상", "text", group="적용/실험"),
      ]),
    T("growth.journal", "growth", "기록 (일지/회고)", "🗒",
      ["일지", "회고", "저널", "다이어리", "TIL", "일기"], ["오늘", "이번 주", "KPT", "잘한 점", "아쉬운 점", "다음 액션"], [
        F("topic", "기록 주제", "text", req=True, group="기록 정보"),
        F("recordDate", "기록 날짜", "date", group="기록 정보"),
        F("frequency", "기록 빈도", "select", options=["매일", "주1회", "월1회", "비정기"], group="기록 정보"),
        F("trigger", "기록 트리거", "longtext", group="기록 정보"),
        F("whatIDid", "오늘/이번 주에 한 일", "longtext", req=True, group="기록 정보", supersedes=["actions"]),
        F("didWell", "잘한 점 1개", "longtext", group="기록 정보", hint="정확히 1개."),
        F("regret", "아쉬운 점 1개", "longtext", group="기록 정보", hint="정확히 1개."),
        F("learned", "배운 점 1개", "longtext", group="기록 정보", supersedes=["learned"], hint="정확히 1개."),
        F("nextAction", "다음 행동 1개", "longtext", group="기록 정보", hint="정확히 1개."),
        F("insights", "인사이트/패턴", "repeater", group="인사이트/패턴", fields=[
            F("pattern", "발견한 패턴", "text", req=True),
            F("evidence", "근거", "text"),
            F("behaviorChange", "바꿀 행동", "longtext")]),
        F("attachment", "첨부", "file", group="인사이트/패턴", supersedes=["evidence"]),
      ]),
    T("growth.goal", "growth", "목표/계획", "🎯",
      ["목표", "계획", "플랜", "로드맵", "OKR", "버킷리스트"], ["마감일", "우선순위", "체크포인트", "달성", "진행률", "성공 기준"], [
        F("goalName", "목표명", "text", req=True, group="목표 정보"),
        F("period", "기간", "daterange", req=True, group="목표 정보", supersedes=["period"]),
        F("goalType", "목표 유형", "select", options=["학습", "커리어", "건강", "프로젝트", "기타"], group="목표 정보"),
        F("goalLevel", "목표 수준", "select", options=["상", "중", "하"], group="목표 정보", supersedes=["difficulty"]),
        F("successCriteria", "성공 기준", "longtext", req=True, group="목표 정보"),
        F("plans", "세부 계획", "repeater", group="세부 계획", fields=[
            F("task", "할 일", "text", req=True),
            F("deadline", "마감일", "date"),
            F("estimate", "예상 소요", "text"),
            F("priority", "우선순위", "text"),
            F("checkpoint", "체크포인트/측정 지표", "longtext")]),
        F("progress", "진행 기록", "repeater", group="진행 기록", fields=[
            F("date", "날짜", "date", req=True),
            F("content", "진행 내용", "longtext", req=True),
            F("blockers", "막힌 점/리스크", "longtext"),
            F("nextAction", "다음 액션", "longtext")]),
        F("evidence", "증빙", "file", group="진행 기록", supersedes=["evidence"]),
      ]),
]

TYPE_BY_ID = {t["id"]: t for t in EXPERIENCE_TYPES}
CAT_BY_ID = {c["id"]: c for c in CATEGORIES}


# ── 공통 항목 중복 제거 + 화면 배치 (ExperienceFormV2.formLayout 재현) ──

def superseded_keys(t) -> set:
    out = set()
    def walk(fs):
        for f in fs:
            for k in f.get("supersedes", []): out.add(k)
            if f.get("fields"): walk(f["fields"])
    walk(t["fields"])
    return out


def all_fields(t) -> List[dict]:
    hidden = superseded_keys(t)
    commons = [f for f in BASE_FIELDS + EXTENDED_FIELDS if f["key"] not in hidden]
    return commons + t["fields"]


def resolve_layout(t) -> Tuple[List[dict], List[str]]:
    hidden = superseded_keys(t)
    header = [f for f in BASE_FIELDS if f["key"] in HEADER_KEYS and f["key"] not in hidden]
    groups: List[dict] = []
    for f in t["fields"]:
        title = f.get("group") or t["label"]
        g = next((x for x in groups if x["title"] == title), None)
        if not g:
            g = {"title": title, "fields": []}
            groups.append(g)
        g["fields"].append(f)
    folded = [f for f in BASE_FIELDS
              if f["key"] not in HEADER_KEYS and f["key"] not in EVIDENCE_KEYS and f["key"] not in hidden]
    extended = folded + [f for f in EXTENDED_FIELDS if f["key"] not in hidden]
    evidence = [f for f in BASE_FIELDS if f["key"] in EVIDENCE_KEYS and f["key"] not in hidden]

    layout = [{"zone": "header", "title": "제목/요약", "collapsed": False, "fields": header}]
    layout += [{"zone": "specialized", "title": g["title"], "collapsed": False, "fields": g["fields"]} for g in groups]
    layout.append({"zone": "extended", "title": "확장 입력 (선택)", "collapsed": True, "fields": extended})
    if evidence:
        layout.append({"zone": "evidence", "title": "증빙 자료", "collapsed": False, "fields": evidence})
    return layout, sorted(hidden)


def label_for_path(t, path: str) -> str:
    fields = all_fields(t)
    labels = []
    for raw in path.split("."):
        key = re.sub(r"\[\d+\]$", "", raw)
        f = next((x for x in fields if x["key"] == key), None)
        if not f: return path
        labels.append(f["label"])
        fields = f.get("fields", [])
    return " > ".join(labels)


# ── FieldSpec → Gemini responseSchema ──────────────────────────────────────────
# Gemini는 type 유니온을 못 받는다 → 대표 타입 + nullable. additionalProperties도 없음.

def _desc(f) -> str:
    bits = [f["label"]]
    if f.get("req"): bits.append("(필수)")
    if f.get("options"):
        bits.append(f"반드시 다음 중 하나: {' | '.join(f['options'])}. 해당 없으면 null.")
    if f.get("hint"): bits.append(f"※ {f['hint']}")
    return " ".join(bits)


def _fschema(f) -> dict:
    k, d = f["kind"], _desc(f)
    if k in ("text", "longtext", "link", "file", "select"):
        extra = {"text": " [한 줄]", "longtext": " [서술형]", "link": " [원문에 있는 URL만]",
                 "file": " [업로드된 파일명 그대로]", "select": ""}[k]
        return {"type": "STRING", "nullable": True, "description": d + extra}
    if k == "date":
        return {"type": "STRING", "nullable": True,
                "description": d + " [YYYY-MM-DD. 월까지만 알면 YYYY-MM, 연도만 알면 YYYY]"}
    if k == "daterange":
        return {"type": "OBJECT", "nullable": True, "description": d + " [기간]",
                "properties": {
                    "start": {"type": "STRING", "nullable": True, "description": "시작일"},
                    "end": {"type": "STRING", "nullable": True, "description": "종료일. 진행 중이면 null"},
                    "ongoing": {"type": "BOOLEAN", "nullable": True, "description": "진행 중 여부"}},
                "propertyOrdering": ["start", "end", "ongoing"]}
    if k in ("checklist", "tags"):
        return {"type": "ARRAY", "nullable": True, "description": d + " [복수]",
                "items": {"type": "STRING"}}
    if k == "repeater":
        return {"type": "ARRAY", "nullable": True,
                "description": d + " [반복 입력. 원문에 있는 건수만큼만 생성. 억지로 채우지 말 것]",
                "items": obj_schema(f.get("fields", []))}
    return {"type": "STRING", "nullable": True, "description": d}


def obj_schema(fields: List[dict]) -> dict:
    return {"type": "OBJECT",
            "properties": {f["key"]: _fschema(f) for f in fields},
            "propertyOrdering": [f["key"] for f in fields]}


def extraction_schema(fields: List[dict]) -> dict:
    return {"type": "OBJECT", "properties": {
        "values": obj_schema(fields),
        "evidence": {"type": "ARRAY", "description":
            "채운 값마다 원문 근거 1개 이상. 근거를 못 대는 값은 채우지 말 것.",
            "items": {"type": "OBJECT", "properties": {
                "path": {"type": "STRING", "description": "필드 경로. 예: courses[0].courseName"},
                "sourceId": {"type": "STRING"},
                "quote": {"type": "STRING", "description": "원문에서 그대로 복사한 문장(200자 이내)"},
                "confidence": {"type": "NUMBER", "description": "0~1"}},
                "propertyOrdering": ["path", "sourceId", "quote", "confidence"]}},
        "unfilled": {"type": "ARRAY", "description": "비워 둔 항목과 그 이유.",
            "items": {"type": "OBJECT", "properties": {
                "path": {"type": "STRING"}, "reason": {"type": "STRING"}},
                "propertyOrdering": ["path", "reason"]}},
    }, "propertyOrdering": ["values", "evidence", "unfilled"]}


# ── 응답 정리: 보기 밖 값·가짜 null·누락 키를 결정론적으로 교정 ──
BLANK = {"", "null", "none", "n/a", "na", "-", "없음", "미상", "해당없음", "해당 없음",
         "알 수 없음", "미기재", "정보 없음", "확인 불가", "undefined"}


def _blank(v) -> bool:
    if v is None: return True
    if isinstance(v, str): return v.strip().lower() in BLANK
    if isinstance(v, (list, dict)): return len(v) == 0
    return False


def _norm(s: str) -> str:
    return re.sub(r"[\s·.\-_/]", "", str(s)).lower()


def coerce(value, f) -> Any:
    """모델 응답을 폼 형태로 되돌린다."""
    k = f["kind"]
    if _blank(value): return None
    if k == "daterange":
        if not isinstance(value, dict): return None
        out = {"start": None, "end": None, "ongoing": None}
        for key in out:
            v = value.get(key)
            out[key] = None if _blank(v) else v
        return None if all(v is None for v in out.values()) else out
    if k == "repeater":
        rows = value if isinstance(value, list) else [value]
        subs = f.get("fields", [])
        out = []
        for row in rows:
            if not isinstance(row, dict): continue
            r = {s["key"]: coerce(row.get(s["key"]), s) for s in subs}
            if any(v is not None for v in r.values()): out.append(r)
        return out or None
    if k in ("checklist", "tags"):
        arr = value if isinstance(value, list) else [value]
        arr = [str(x).strip() for x in arr if not _blank(x)]
        if f.get("options") and not f.get("free"):
            arr = [m for m in (_match_enum(x, f["options"]) for x in arr) if m]
        return arr or None
    if k == "select" and f.get("options"):
        return _match_enum(str(value), f["options"])
    return str(value).strip() or None


def _match_enum(raw: str, options: List[str]) -> Optional[str]:
    n = _norm(raw)
    for o in options:
        if _norm(o) == n: return o
    for o in options:
        if n and (n in _norm(o) or _norm(o) in n): return o
    return None


def coerce_values(values: dict, fields: List[dict]) -> dict:
    src = values if isinstance(values, dict) else {}
    return {f["key"]: coerce(src.get(f["key"]), f) for f in fields}


# ── 경로 유틸 ──
def _segs(p: str):
    for raw in p.split("."):
        m = re.match(r"^([^\[]+)\[(\d+)\]$", raw)
        yield (m.group(1), int(m.group(2))) if m else (raw, None)


def get_path(obj, path: str):
    cur = obj
    for key, idx in _segs(path):
        if not isinstance(cur, dict): return None
        cur = cur.get(key)
        if idx is not None:
            if not isinstance(cur, list) or idx >= len(cur): return None
            cur = cur[idx]
    return cur


def set_path(obj: dict, path: str, value):
    segs = list(_segs(path))
    cur = obj
    for i, (key, idx) in enumerate(segs):
        last = i == len(segs) - 1
        if last:
            if idx is None: cur[key] = value
            else:
                cur.setdefault(key, [])
                while len(cur[key]) <= idx: cur[key].append({})
                cur[key][idx] = value
            return
        if idx is None:
            if not isinstance(cur.get(key), dict): cur[key] = {}
            cur = cur[key]
        else:
            cur.setdefault(key, [])
            while len(cur[key]) <= idx: cur[key].append({})
            cur = cur[key][idx]


def leaf_paths(value, prefix="") -> List[str]:
    if value is None: return []
    if isinstance(value, list):
        out = []
        for i, v in enumerate(value): out += leaf_paths(v, f"{prefix}[{i}]")
        return out
    if isinstance(value, dict):
        out = []
        for k, v in value.items(): out += leaf_paths(v, f"{prefix}.{k}" if prefix else k)
        return out
    return [prefix] if prefix else []


# ==============================================================================
#  2. Gemini 클라이언트 — 모델 자동 선택 + 재시도 + 한국어 오류 안내
# ==============================================================================

class Gemini:
    PREFER = [r"^gemini-(\d+(?:\.\d+)?)-pro$", r"^gemini-(\d+(?:\.\d+)?)-pro-preview",
              r"^gemini-(\d+(?:\.\d+)?)-flash$", r"^gemini-(\d+(?:\.\d+)?)-flash-preview"]
    FALLBACK = "gemini-2.5-pro"

    def __init__(self, api_key: str, pin: str = ""):
        if not api_key or not api_key.strip():
            raise RuntimeError(
                "Google API 키가 비어 있습니다.\n"
                "  https://aistudio.google.com/apikey 에서 키를 발급받아\n"
                "  맨 위 GOOGLE_API_KEY = \"...\" 에 넣어주세요.")
        self.key = api_key.strip()
        self.pin = pin.strip()
        self._models = None
        self.usage = {"in": 0, "out": 0, "cost": 0.0, "calls": []}

    def list_models(self) -> List[str]:
        r = requests.get(f"{API}/models", params={"key": self.key, "pageSize": 200}, timeout=30)
        if not r.ok: raise RuntimeError(self._err(r, "모델 목록 조회"))
        return [m["name"].replace("models/", "") for m in r.json().get("models", [])
                if "generateContent" in m.get("supportedGenerationMethods", [])]

    def models(self) -> Tuple[str, str]:
        """(주 모델, 보조 모델). 실패해도 파이프라인은 계속 돈다."""
        if self._models:
            return self._models
        if self.pin:
            self._models = (self.pin, self.pin)
            return self._models
        try:
            usable = self.list_models()
            main = self._pick(usable) or self.FALLBACK
            light = self._pick_tier(usable, "flash") or main
            # 최신 세대 flash가 구세대 pro보다 나은 경우가 잦다 → main이 flash여도 그대로 둔다
            self._models = (main, light)
        except Exception:
            self._models = (self.FALLBACK, self.FALLBACK)
        return self._models

    @staticmethod
    def _pick(models: List[str], prefer=None) -> Optional[str]:
        """세대를 먼저 보고, 같은 세대 안에서 tier를 본다.

        예전에는 'pro 패턴'을 먼저 훑어서 gemini-3.8-flash 가 있는데도
        gemini-2.5-pro 를 골랐다. 세대 차가 tier 차보다 크므로 순서를 뒤집는다.
        """
        scored = []
        for m in models:
            g = re.match(r"^gemini-(\d+(?:\.\d+)?)-(pro|flash)(?:-(preview|exp).*)?$", m)
            if not g:
                continue
            gen = float(g.group(1))
            tier = 0 if g.group(2) == "pro" else 1
            preview = 1 if g.group(3) else 0
            scored.append((-gen, tier, preview, len(m), m))
        if not scored:
            return None
        scored.sort()
        return scored[0][4]

    @staticmethod
    def _pick_tier(models: List[str], tier: str) -> Optional[str]:
        """특정 tier에서 가장 최신 세대."""
        scored = []
        for m in models:
            g = re.match(rf"^gemini-(\d+(?:\.\d+)?)-{tier}(?:-(preview|exp).*)?$", m)
            if not g:
                continue
            scored.append((-float(g.group(1)), 1 if g.group(2) else 0, len(m), m))
        scored.sort()
        return scored[0][3] if scored else None

    def verify(self) -> Tuple[bool, str]:
        try:
            usable = self.list_models()
            if not usable: return False, "generateContent를 지원하는 모델이 없습니다."
            main, light = self.models()
            if self.pin and self.pin not in usable:
                return False, f'고정 모델 "{self.pin}" 사용 불가. 가능: {", ".join(usable[:8])}'
            return True, f'모델 {len(usable)}개 중 "{main}" (보조 "{light}") 선택'
        except Exception as e:
            return False, str(e)

    # ── 호출 ──
    def generate(self, stage: str, parts: List[dict], system: str,
                 schema: Optional[dict] = None, max_tokens: int = 32768,
                 thinking: Optional[int] = -1, light: bool = False,
                 temperature: float = 0.1) -> str:
        main, lite = self.models()
        model = lite if light else main
        cfg: Dict[str, Any] = {"temperature": temperature, "maxOutputTokens": max_tokens}
        if schema:
            cfg["responseMimeType"] = "application/json"
            cfg["responseSchema"] = schema
        if thinking is not None:
            cfg["thinkingConfig"] = {"thinkingBudget": thinking}

        body = {"contents": [{"role": "user", "parts": parts}], "generationConfig": cfg,
                "safetySettings": [{"category": c, "threshold": "BLOCK_ONLY_HIGH"} for c in (
                    "HARM_CATEGORY_HARASSMENT", "HARM_CATEGORY_HATE_SPEECH",
                    "HARM_CATEGORY_SEXUALLY_EXPLICIT", "HARM_CATEGORY_DANGEROUS_CONTENT")]}
        if system: body["systemInstruction"] = {"parts": [{"text": system}]}

        t0 = time.time()
        data = self._post(model, body)
        if "error" in data and re.search("thinking", json.dumps(data["error"]), re.I):
            cfg.pop("thinkingConfig", None)
            data = self._post(model, body)
        if "error" in data:
            raise RuntimeError(f"[{stage}] Gemini 오류: {data['error'].get('message', data['error'])}")

        cand = (data.get("candidates") or [{}])[0]
        finish = cand.get("finishReason")
        if finish in ("SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST"):
            raise RuntimeError(f"[{stage}] 안전 필터에 걸렸습니다({finish}). "
                               "개인정보가 많은 문서라면 해당 부분을 가리고 다시 시도해 주세요.")
        if finish == "MAX_TOKENS":
            raise RuntimeError(f"[{stage}] 응답이 최대 길이를 넘었습니다. 파일을 나눠 올려 주세요.")

        u = data.get("usageMetadata", {})
        tin = u.get("promptTokenCount", 0)
        tout = u.get("candidatesTokenCount", 0) + u.get("thoughtsTokenCount", 0)
        self.usage["in"] += tin
        self.usage["out"] += tout
        rate = PRICE_FLASH if "flash" in model else PRICE_PRO
        self.usage["cost"] = self.usage.get("cost", 0.0) + tin / 1e6 * rate[0] + tout / 1e6 * rate[1]
        self.usage["calls"].append((stage, round(time.time() - t0, 1), model))

        text = "".join(p.get("text", "") for p in cand.get("content", {}).get("parts", [])).strip()
        if not text:
            raise RuntimeError(f"[{stage}] 빈 응답 (finishReason={finish})")
        return text

    def parallel(self, jobs: List[dict]) -> List[Any]:
        """여러 호출을 동시에 던진다. 같은 벽시계 시간에 더 많은 시도를 한다.

        비용 절감의 핵심이다 — 값싼 모델로 두 번 시도해 좋은 쪽을 고르는 편이
        비싼 모델로 한 번 시도하고 틀려서 재작업하는 것보다 싸다.
        """
        from concurrent.futures import ThreadPoolExecutor
        out: List[Any] = [None] * len(jobs)

        def one(i: int):
            job = dict(jobs[i])
            fn = self.structured if job.pop("kind", "structured") == "structured" else self.generate
            try:
                out[i] = fn(**job)
            except Exception as e:                       # 한쪽이 죽어도 나머지는 산다
                out[i] = e

        with ThreadPoolExecutor(max_workers=min(4, len(jobs))) as ex:
            list(ex.map(one, range(len(jobs))))
        return out

    def structured(self, stage: str, parts, system, schema, max_tokens=32768,
                   thinking=-1, light=False, temperature=0.1) -> dict:
        raw = self.generate(stage, parts, system, schema, max_tokens, thinking, light,
                            temperature)
        raw = re.sub(r"^\s*```(?:json)?\s*|\s*```\s*$", "", raw)
        try:
            return json.loads(raw)
        except json.JSONDecodeError as e:
            raise RuntimeError(f"[{stage}] JSON 파싱 실패: {e}\n앞부분: {raw[:300]}")

    def _post(self, model: str, body: dict) -> dict:
        last = None
        for i in range(4):
            try:
                r = requests.post(f"{API}/models/{model}:generateContent",
                                  params={"key": self.key}, json=body, timeout=300)
                if r.status_code == 429 or r.status_code >= 500:
                    last = RuntimeError(self._err(r, "생성"))
                    time.sleep(2 ** i)
                    continue
                return r.json()
            except requests.RequestException as e:
                last = e
                time.sleep(2 ** i)
        raise last or RuntimeError("요청 실패")

    @staticmethod
    def _err(r, what: str) -> str:
        try: detail = r.json().get("error", {}).get("message", "")
        except Exception: detail = r.text[:200]
        if r.status_code == 400 and "API key not valid" in detail:
            return "Google API 키가 올바르지 않습니다. https://aistudio.google.com/apikey 에서 확인하세요."
        if r.status_code == 403:
            return f"권한 없음(403). Generative Language API가 켜져 있는지 확인하세요. {detail}"
        if r.status_code == 429:
            return f"요청 한도 초과(429). 잠시 후 다시 시도합니다. {detail}"
        return f"{what} 실패 (HTTP {r.status_code}) {detail}"


# ==============================================================================
#  3. 파일 수집 — 어떤 형식이든 텍스트로
# ==============================================================================

OCR_SYSTEM = """당신은 한국어/영어 혼용 문서 전용 판독 엔진이다.
1. 보이는 모든 글자를 **있는 그대로** 옮겨 적는다. 요약·의역·맞춤법 교정 금지.
2. 읽기 순서를 지킨다. 다단이면 왼쪽 단을 끝까지 읽고 오른쪽으로.
3. 표는 마크다운 표로. 체크박스는 [x] / [ ] 로.
4. 확신 없는 글자는 그 부분만 «불명» 으로 감싼다. 추측 금지.
5. 손글씨·도장·워터마크 안의 글자도 읽는다.
6. 숫자와 단위는 특히 정확하게. 0/O, 1/l/I, 5/S, 8/B 혼동 주의.
7. 글자가 하나도 없으면 정확히 "[[NO_TEXT]]" 만 출력한다.
8. 설명·머리말 없이 추출된 텍스트만 출력한다."""

STT_SYSTEM = """당신은 한국어 음성 받아쓰기 엔진이다.
1. 들리는 말을 그대로 받아 적는다. 요약·의역 금지.
2. 화자가 여럿이면 "화자1:", "화자2:" 로 구분한다.
3. 안 들리는 구간은 «불명» 으로 표시한다.
4. 말소리가 없으면 정확히 "[[NO_SPEECH]]" 만 출력한다."""

NATIVE_MIME = {  # Gemini가 직접 읽는 형식
    "pdf": "application/pdf",
    "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
    "webp": "image/webp", "heic": "image/heic", "heif": "image/heif", "gif": "image/gif",
    "mp3": "audio/mp3", "m4a": "audio/mp4", "wav": "audio/wav",
    "flac": "audio/flac", "ogg": "audio/ogg", "aac": "audio/aac",
    "mp4": "video/mp4", "mov": "video/quicktime", "webm": "video/webm",
}
TEXT_EXT = {"txt", "md", "markdown", "csv", "tsv", "json", "jsonl", "yaml", "yml", "log",
            "srt", "vtt", "html", "htm", "xml", "rtf", "tex", "eml",
            "py", "js", "ts", "tsx", "jsx", "java", "go", "rb", "c", "cpp", "cs",
            "php", "kt", "swift", "rs", "sql", "sh", "css", "ipynb"}
MAX_INLINE = 18 * 1024 * 1024


def _ext(name: str) -> str:
    m = re.search(r"\.([A-Za-z0-9]+)$", name.strip())
    return m.group(1).lower() if m else ""


def _decode(b: bytes) -> str:
    for enc in ("utf-8", "cp949", "euc-kr", "utf-16"):
        try:
            s = b.decode(enc)
            if s.count("�") / max(1, len(s)) < 0.01: return s
        except (UnicodeDecodeError, LookupError):
            continue
    return b.decode("utf-8", errors="replace")


def _html_to_text(s: str) -> str:
    s = re.sub(r"<(script|style)[\s\S]*?</\1>", " ", s, flags=re.I)
    s = re.sub(r"<br\s*/?>|</(p|div|li|tr|h[1-6])>", "\n", s, flags=re.I)
    s = re.sub(r"<[^>]+>", " ", s)
    for a, b in [("&nbsp;", " "), ("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">"), ("&quot;", '"')]:
        s = s.replace(a, b)
    return re.sub(r"\n{3,}", "\n\n", re.sub(r"[ \t]{2,}", " ", s)).strip()


def _office_text(name: str, data: bytes) -> Tuple[str, List[str]]:
    """docx / pptx / xlsx / hwpx — 라이브러리가 없으면 zip+xml로 직접 긁는다."""
    ext, warn = _ext(name), []
    try:
        if ext in ("docx", "doc"):
            docx = _pip("docx", "python-docx")
            if docx:
                d = docx.Document(io.BytesIO(data))
                paras = [p.text for p in d.paragraphs]
                for tb in d.tables:
                    for row in tb.rows:
                        paras.append(" | ".join(c.text.strip() for c in row.cells))
                return "\n".join(x for x in paras if x.strip()), warn
        if ext in ("pptx", "ppt"):
            pptx = _pip("pptx", "python-pptx")
            if pptx:
                pr = pptx.Presentation(io.BytesIO(data))
                out = []
                for i, s in enumerate(pr.slides, 1):
                    bits = [sh.text for sh in s.shapes if getattr(sh, "has_text_frame", False)]
                    note = ""
                    if s.has_notes_slide and s.notes_slide.notes_text_frame:
                        note = s.notes_slide.notes_text_frame.text
                    out.append(f"[슬라이드 {i}]\n" + "\n".join(b for b in bits if b.strip())
                               + (f"\n[발표자 노트]\n{note}" if note.strip() else ""))
                return "\n\n".join(out), warn
        if ext in ("xlsx", "xls", "xlsm"):
            ox = _pip("openpyxl")
            if ox:
                wb = ox.load_workbook(io.BytesIO(data), data_only=True)
                out = []
                for ws in wb.worksheets:
                    rows = []
                    for r in ws.iter_rows(values_only=True):
                        if any(c is not None for c in r):
                            rows.append(" | ".join("" if c is None else str(c) for c in r))
                        if len(rows) >= 400: break
                    out.append(f"[시트: {ws.title}]\n" + "\n".join(rows))
                return "\n\n".join(out), warn
    except Exception as e:
        warn.append(f"{name}: 전용 파서 실패({e}) → XML에서 직접 추출")

    # 폴백: OOXML/HWPX zip 안의 XML에서 텍스트만 긁어낸다
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            names = [n for n in z.namelist()
                     if re.search(r"(word/document|ppt/slides/slide\d+|xl/sharedStrings|Contents/section\d+)\.xml$", n)]
            chunks = []
            for n in sorted(names):
                xml = z.read(n).decode("utf-8", errors="ignore")
                xml = re.sub(r"</(w:p|a:p|hp:p)>", "\n", xml)
                xml = re.sub(r"</(w:tc|a:tc|hp:tc)>", " | ", xml)
                chunks.append(re.sub(r"<[^>]+>", "", xml))
            txt = re.sub(r"\n{3,}", "\n\n", "\n".join(chunks)).strip()
            if txt: return txt, warn
    except Exception:
        pass
    warn.append(f"{name}: 본문을 읽지 못했습니다. PDF로 저장해 올리면 정확히 인식됩니다.")
    return "", warn



def _pdf_text_layer(data: bytes) -> Tuple[str, int, bool]:
    """PDF 텍스트 레이어 추출. 글자 밀도가 낮으면(스캔본) 포기하고 OCR로 넘긴다."""
    mod = _pip("pypdf") or _pip("PyPDF2")
    if not mod:
        return "", 0, False
    try:
        Reader = getattr(mod, "PdfReader", None)
        if Reader is None:
            return "", 0, False
        reader = Reader(io.BytesIO(data))
        pages = len(reader.pages)
        chunks = []
        for i, page in enumerate(reader.pages[:80], 1):
            try:
                t = page.extract_text() or ""
            except Exception:
                t = ""
            if t.strip():
                chunks.append(t.strip())
        text = "\n\n".join(chunks).strip()
        text = re.sub(r"\n{3,}", "\n\n", text)
        # 쪽당 평균 120자 미만이면 스캔 이미지로 본다
        if not text or len(text) / max(1, min(pages, 80)) < 120:
            return "", pages, False
        return text, pages, True
    except (KeyboardInterrupt, SystemExit):
        raise
    except BaseException:
        return "", 0, False


def ingest(g: Gemini, name: str, data: bytes, log=print) -> List[dict]:
    """파일 하나 → 문서 레코드(들). 압축이면 안쪽 파일마다 하나씩."""
    ext = _ext(name)
    warn: List[str] = []

    # 압축 → 재귀
    if ext == "zip" or (data[:4] == b"PK\x03\x04" and ext not in
                        ("docx", "pptx", "xlsx", "hwpx", "doc", "ppt", "xls")):
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as z:
                inner = [n for n in z.namelist()
                         if not n.endswith("/") and "__MACOSX" not in n and not n.endswith(".DS_Store")]
                if inner and not any(n.startswith(("word/", "ppt/", "xl/")) for n in inner):
                    log(f"  [수집] 압축 해제: {name} ({len(inner)}개)")
                    docs = []
                    for n in inner[:20]:
                        docs += ingest(g, f"{name}/{n}", z.read(n), log)
                    return docs
        except zipfile.BadZipFile:
            pass

    # PDF는 텍스트 레이어부터 확인한다 — 있으면 Vision 호출이 통째로 빠진다.
    # 스캔본이 아니라면 더 싸고, 표·수식 보존도 더 정확하다.
    if ext == "pdf":
        text, pages, ok = _pdf_text_layer(data)
        if ok:
            log(f"  [판독] {name}: 텍스트 레이어 사용 ({pages}쪽, {len(text):,}자) — Vision 호출 생략")
            return [_doc(name, "pdf", text, 1.0, warn)]

    # Gemini가 직접 읽는 형식 (PDF·이미지·오디오·영상)
    if ext in NATIVE_MIME:
        mime = NATIVE_MIME[ext]
        if len(data) > MAX_INLINE:
            return [_doc(name, ext, "", 0.1,
                         [f"{name}: {len(data)/1e6:.1f}MB로 너무 큽니다(18MB 이하). 잘라서 올려주세요."])]
        kind = "audio" if mime.startswith(("audio", "video")) else ("pdf" if ext == "pdf" else "image")
        log(f"  [{'받아쓰기' if kind == 'audio' else 'OCR/판독'}] {name}")
        system = STT_SYSTEM if kind == "audio" else OCR_SYSTEM
        try:
            text = g.generate("ocr", [
                {"inline_data": {"mime_type": mime, "data": base64.b64encode(data).decode()}},
                {"text": f"파일명: {name}. 위 규칙대로 처리하라."},
            ], system, thinking=0, light=True)
        except Exception as e:
            return [_doc(name, kind, "", 0.0, [f"{name}: 판독 실패 — {e}"])]
        if text.strip() in ("[[NO_TEXT]]", "[[NO_SPEECH]]"):
            return [_doc(name, kind, "", 0.2, [f"{name}: 읽을 수 있는 내용이 없습니다."])]
        unknown = text.count("«불명»")
        conf = max(0.35, 0.92 - unknown * 0.02)
        if conf < 0.6:
            warn.append(f"{name}: 판독 신뢰도가 낮습니다(«불명» {unknown}곳). 더 선명한 원본을 올리면 좋아집니다.")
        return [_doc(name, kind, text, conf, warn)]

    # 오피스/한글
    if ext in ("docx", "doc", "pptx", "ppt", "xlsx", "xls", "xlsm", "hwpx", "odt", "odp", "ods"):
        text, w = _office_text(name, data)
        return [_doc(name, ext, text, 1.0 if text else 0.1, w)]

    if ext == "hwp":
        return [_doc(name, "hwp", "", 0.1,
                     [f"{name}: 구형 HWP는 직접 읽지 못합니다. 한글에서 PDF로 저장해 올려주세요."])]

    # 텍스트 계열
    if ext in TEXT_EXT or not ext:
        s = _decode(data)
        if ext in ("html", "htm", "xml"): s = _html_to_text(s)
        elif ext in ("srt", "vtt"):
            s = "\n".join(l for l in s.splitlines()
                          if l.strip() and "-->" not in l and not l.strip().isdigit())
        elif ext in ("csv", "tsv"):
            delim = "\t" if ext == "tsv" else ","
            lines = [l for l in s.splitlines() if l.strip()][:400]
            if len(lines) > 1:
                head = lines[0].split(delim)
                body = ["  ".join(f"{h.strip()}: {c.strip()}"
                                  for h, c in zip(head, r.split(delim)) if c.strip())
                        for r in lines[1:]]
                s = f"[표: {name}] 열: {' | '.join(head)}\n" + "\n".join(body)
        elif ext == "ipynb":
            try:
                nb = json.loads(s)
                s = "\n\n".join(
                    ("".join(c.get("source", [])) if c.get("cell_type") == "markdown"
                     else "```\n" + "".join(c.get("source", [])) + "\n```")
                    for c in nb.get("cells", []))
            except Exception: pass
        return [_doc(name, "text", s, 1.0, warn)]

    return [_doc(name, "unknown", "", 0.1,
                 [f"{name}: 지원하지 않는 형식입니다. PDF·이미지·텍스트로 변환해 올려주세요."])]


def _doc(name, kind, text, conf, warn) -> dict:
    return {"sourceId": "", "name": name, "kind": kind,
            "text": (text or "").strip(), "confidence": conf, "warnings": warn or []}


# ==============================================================================
#  4. 에이전트 — ① 분류 → ② 배분 → ③ 감독 → ④ Fallback 안내
# ==============================================================================

def _catalog() -> str:
    out = []
    for c in CATEGORIES:
        ts = [f"  · {t['id']} — {t['label']}\n      동의어: {', '.join(t['aliases'])}"
              f"\n      신호: {', '.join(t['signals'])}"
              f"\n      전용 항목: {', '.join(f['label'] for f in t['fields'])}"
              for t in EXPERIENCE_TYPES if t["category"] == c["id"]]
        out.append(f"[{c['id']}] {c['emoji']} {c['label']}\n"
                   f"  대분류 신호: {', '.join(c['signals'])}\n" + "\n".join(ts))
    return "\n\n".join(out)


CLASSIFY_SYSTEM = """당신은 ARC 경험 기록 서비스의 **1단계 분류 에이전트**다.
사용자가 올린 산출물을 읽고 그것이 어떤 경험인지 판별한다.

작업 순서는 반드시 이 순서다.
  1) 먼저 **대분류**(학업 / 커리어 / 프로젝트 / 개인성장) 4개 중 하나를 고른다.
  2) 그 대분류 안의 **세부 유형**을 고른다.

── 판별 원칙 ──
1. **산출물의 형식이 아니라 활동의 성격**으로 판단한다.
   PDF라서 논문이 아니고, 코드라서 개인 프로젝트가 아니다. 누가·어디서·왜 한 일인지를 본다.
2. 경계는 이렇게 자른다.
   · 회사에서 급여를 받고 한 일 → career.work (팀 프로젝트처럼 보여도)
   · 학교 수업의 일부로 한 팀 과제 → academic.major_course (수업 기록 안에 담는다)
   · 수업/회사와 무관하게 스스로 만든 것 → project.personal / project.team
   · 대회에서 상을 받은 게 핵심이면 → career.award
   · 상을 못 받았거나 참가가 핵심이면 → career.external 또는 project.*
   · 학회·동아리는 소속 단체가 주체, 대외활동은 외부 기관이 주최
   · 결과물의 '완성도·작품성'이 핵심이면 project.creative
   · 배운 것/느낀 것이 핵심이고 산출물이 부차적이면 growth.*
3. 근거가 약하면 confidence를 정직하게 낮춘다.
4. 한 파일에 서로 다른 경험이 여러 개 섞여 있으면 multipleExperiences=true.
5. rationale은 한국어 2~3문장. 원문 표현을 인용해 근거를 밝힌다.

── 경험 유형 카탈로그 (18종) ──
""" + _catalog()

CLASSIFY_SCHEMA = {"type": "OBJECT", "properties": {
    "categoryId": {"type": "STRING", "description": "academic | career | project | growth"},
    "typeId": {"type": "STRING", "description": "카탈로그의 유형 id"},
    "confidence": {"type": "NUMBER", "description": "0~1. 근거가 약하면 낮출 것."},
    "rationale": {"type": "STRING", "description": "한국어 2~3문장. 원문 인용."},
    "alternatives": {"type": "ARRAY", "items": {"type": "OBJECT", "properties": {
        "typeId": {"type": "STRING"}, "confidence": {"type": "NUMBER"}, "reason": {"type": "STRING"}},
        "propertyOrdering": ["typeId", "confidence", "reason"]}},
    "multipleExperiences": {"type": "BOOLEAN"},
}, "propertyOrdering": ["categoryId", "typeId", "confidence", "rationale",
                        "alternatives", "multipleExperiences"]}


def classify(g: Gemini, docs: List[dict], hint: str = "") -> dict:
    listing = "\n".join(f"- {d['name']} ({d['kind']}, {len(d['text']):,}자, "
                        f"품질 {d['confidence']*100:.0f}%)" for d in docs)
    body = "\n\n".join(f"[{d['sourceId']} {d['name']}]\n{d['text'][:6000]}" for d in docs)
    parts = [{"text": f"[업로드된 파일]\n{listing}\n\n[본문 발췌]\n{body}"}]
    if hint: parts.append({"text": f"사용자가 준 추가 맥락: {hint}"})

    r = g.structured("classify", parts, CLASSIFY_SYSTEM, CLASSIFY_SCHEMA,
                     max_tokens=8000, thinking=-1)
    tid = r.get("typeId")
    if tid not in TYPE_BY_ID:                      # 모델이 이상한 id를 주면 라벨로 재매칭
        tid = next((t["id"] for t in EXPERIENCE_TYPES
                    if t["label"] in str(r.get("typeId", ""))), "project.personal")
        r["typeId"] = tid
    r["categoryId"] = TYPE_BY_ID[tid]["category"]
    r.setdefault("alternatives", [])
    r.setdefault("confidence", 0.5)
    return r


EXTRACT_RULES = """당신은 ARC 경험 기록 서비스의 **2단계 배분 에이전트**다.
확정된 경험 유형의 입력 항목에, 원문 내용을 요약해서 나눠 담는 것이 임무다.

── 절대 규칙 ──
1. **원문에 없는 사실을 만들지 않는다.** 이름·숫자·날짜·기관명·성과는 원문에 있는 것만.
   추정·보간 금지. 근거를 못 대면 그 항목은 null로 비운다.
2. **비우는 것이 틀리게 채우는 것보다 낫다.** 빈 항목은 뒤에서 사용자에게 되묻는다.
3. 채운 값마다 evidence에 근거를 남긴다. quote는 원문에서 **그대로 복사**한 문장이어야 한다.
   요약한 문장을 quote에 넣지 말 것.
4. **'나'와 '팀'을 구분한다.** 팀 전체가 한 일을 '내 역할'에 쓰지 않는다.
5. **한 항목에 몰아넣지 않는다.** 반복 입력이 있으면 원문의 건수만큼 항목을 만들어 쪼갠다.
   거꾸로 원문에 1건뿐인데 억지로 여러 건을 만들지 않는다.
6. 같은 내용을 여러 항목에 중복해서 넣지 않는다. 가장 적합한 한 곳에만.
7. 형식을 지킨다. 날짜는 YYYY-MM-DD, 선택 항목은 주어진 보기 중에서만, 없으면 null.
8. 서술형은 **원문의 사실을 유지하되 군더더기를 덜어낸 요약**으로. 과장·미화 금지. 한국어로.
9. '한 줄 요약'은 80자 내외 한 문장. '핵심 성과'는 원문에 있는 수치만 포함한다.
10. 파일 항목에는 업로드된 파일명을 그대로. 없으면 null.
11. 텍스트 품질이 낮은 문서에서만 나온 값은 confidence를 0.5 이하로. «불명» 주변 값은 신뢰하지 않는다.
12. unfilled에 비워 둔 항목을 **왜** 비웠는지와 함께 모두 적는다.

── 성과·결과를 제대로 뽑는 법 (여기서 가장 많이 실패한다) ──
13. '사실 시트'의 수치 목록을 **한 줄씩 훑으면서** 성과 항목에 옮겨 담는다.
    before→after가 있으면 반드시 둘 다 쓴다. (예: "응답시간 820ms → 210ms")
    원문 수치에서 계산된 값(차이·증감율)은 써도 된다. 단 계산 근거가 원문에 있어야 한다.
14. 성과는 **행동이 아니라 변화**다.
    나쁜 예: "Redis 캐시를 적용했다"          ← 이건 '내가 한 행동'이다
    좋은 예: "Redis 캐시 적용으로 평균 응답시간을 820ms에서 210ms로 줄였다"
15. 수치가 전혀 없는 문서라면 **질적 성과**라도 구체적으로 쓴다.
    나쁜 예: "시스템을 성공적으로 구축했다"
    좋은 예: "7개 계층과 감독 에이전트로 역할을 분리해, 검증 규칙을 29종까지 확장했다"
16. 원문이 메모·일기·구어체여도 성과를 찾아낸다.
    "개꿀", "줄임", "나름 임팩트 있었던 듯" 같은 표현 뒤에 숨은 사실을 문서어로 옮긴다.
    단 원문에 없는 수치나 평가를 보태지 않는다.
17. 오타·비문이 있으면 맥락으로 의미를 복원해서 이해하되,
    인용(quote)에는 **원문 표기를 그대로** 옮긴다. 고쳐서 인용하지 않는다."""


def _outline(t) -> str:
    layout, _ = resolve_layout(t)
    def render(f, depth=0):
        pad = "  " * depth
        opt = f" 〔{'·'.join(f['options'])}〕" if f.get("options") else ""
        req = " (필수)" if f.get("req") else ""
        hint = f"  ※ {f['hint']}" if f.get("hint") else ""
        head = f"{pad}- {f['key']} | {f['label']} — {f['kind']}{opt}{req}{hint}"
        kids = "\n".join(render(c, depth + 2) for c in f.get("fields", []))
        return f"{head}\n{kids}" if kids else head
    return "\n\n".join(
        f"### {s['title']}{' (접힘)' if s['collapsed'] else ''}\n"
        + "\n".join(render(f) for f in s["fields"]) for s in layout)


def evidence_bundle(docs: List[dict], budget: int = 120_000) -> str:
    total = sum(len(d["text"]) for d in docs) or 1
    out = []
    for d in docs:
        share = len(d["text"]) if total <= budget else max(2000, int(len(d["text"]) / total * budget))
        body = d["text"] if len(d["text"]) <= share else (
            d["text"][:int(share * .62)] + "\n…(중략)…\n" + d["text"][-int(share * .35):])
        q = "높음" if d["confidence"] >= .85 else ("보통 (오독 가능)" if d["confidence"] >= .6
             else "낮음 (오독 주의 — 이 문서만 근거인 값은 신뢰도를 낮출 것)")
        w = f"\n[경고] {' / '.join(d['warnings'])}" if d["warnings"] else ""
        out.append(f"<<<파일 sourceId={d['sourceId']} 이름=\"{d['name']}\" "
                   f"형식={d['kind']} 텍스트품질={q}>>>{w}\n{body or '(텍스트 없음)'}\n"
                   f"<<<파일 끝 {d['sourceId']}>>>")
    return "\n\n".join(out)


def extract(g: Gemini, t: dict, docs: List[dict], hint: str = "", feedback: str = "",
            fs_text: str = "", temperature: float = 0.1, light: bool = True) -> dict:
    fields = all_fields(t)
    system = (f"{EXTRACT_RULES}\n\n── 이번 경험 유형: {t['emoji']} {t['label']} ({t['id']}) ──\n"
              f"아래가 채워야 할 전체 항목이다. 화면 배치 순서 그대로다.\n\n{_outline(t)}\n\n"
              f"업로드된 파일명: {', '.join(d['name'] for d in docs)}")
    parts = []
    if fs_text:
        parts.append({"text": "## 원문에서 미리 뽑아 둔 사실 시트 "
                              "(수치·고유명사 누락을 막기 위한 것. 여기 있는 값은 원문 근거가 있다)\n"
                              + fs_text})
    parts.append({"text": "## 원문\n" + evidence_bundle(docs)})
    if hint: parts.append({"text": f"사용자가 준 추가 맥락: {hint}"})
    if feedback: parts.append({"text": f"── 감독 에이전트의 재작업 지시 ──\n{feedback}"})

    r = g.structured("extract", parts, system, extraction_schema(fields),
                     max_tokens=32768, thinking=-1 if not light else 0,
                     light=light, temperature=temperature)

    values = coerce_values(r.get("values") or {}, fields)
    prov: Dict[str, dict] = {}
    for e in (r.get("evidence") or []):
        p = e.get("path")
        if not p: continue
        c = float(e.get("confidence") or 0.5)
        slot = prov.setdefault(p, {"path": p, "confidence": c, "quotes": []})
        slot["confidence"] = max(slot["confidence"], c)
        if e.get("quote"):
            slot["quotes"].append({"sourceId": e.get("sourceId", ""), "text": e["quote"]})

    unfilled = [{"path": u["path"], "label": label_for_path(t, u["path"]),
                 "reason": u.get("reason", "")} for u in (r.get("unfilled") or []) if u.get("path")]

    # 신뢰도 미달 값은 비운다 — "틀리게 채우느니 비운다"
    for p, fv in list(prov.items()):
        if fv["confidence"] < 0.4:
            try: set_path(values, p, None)
            except Exception: pass
            unfilled.append({"path": p, "label": label_for_path(t, p),
                             "reason": f"근거가 약해 비웠습니다 (신뢰도 {fv['confidence']*100:.0f}%)"})
            prov.pop(p)

    seen, dedup = set(), []
    for u in unfilled:
        if u["path"] in seen: continue
        seen.add(u["path"]); dedup.append(u)
    return {"values": values, "provenance": list(prov.values()), "unfilled": dedup}


SUPERVISE_SYSTEM = """당신은 ARC 경험 기록 서비스의 **3단계 감독(Supervisor) 에이전트**다.
앞 단계가 만든 결과를 **원문과 대조해 검수**한다. 당신은 작성자가 아니라 심사자다.
좋게 봐주지 말고, 틀린 것을 찾아내는 것이 임무다.

── 검수 항목 (이 순서로) ──
1. **유형 판별이 맞나** — 명백히 다른 유형이면 verdict="reclassify", reclassifyTo에 올바른 id.
   애매한 정도로는 재분류하지 않는다. 확실할 때만.
2. **환각** — 원문에 근거가 없는 이름·숫자·날짜·기관·성과가 들어갔는가.
   ※ 가장 중요하다. 하나라도 있으면 verdict는 최소 "revise". patch로 null 또는 근거 있는 값으로.
3. **주어 왜곡** — 팀이 한 일을 '내 역할'에 쓰지 않았는가.
4. **오배치** — 다른 항목에 들어가야 할 내용이 엉뚱한 칸에 있는가.
5. **요약 왜곡** — "참여했다"를 "주도했다"로, "시도했다"를 "달성했다"로 바꾼 것은 왜곡이다.
6. **중복** — 같은 내용이 두 항목 이상에 들어갔는가. 한 곳만 남긴다.
7. **분해 누락** — 반복 입력에 담아야 할 여러 건이 한 칸에 뭉쳐 있는가.
8. **과소 추출** — 원문에 분명히 있는데 비워 둔 항목. 근거가 있을 때만 채운다.
9. **형식** — 기계 검증기가 이미 찾은 것은 아래에 목록으로 준다.

── 판정 ──
· blocker(환각·필수 누락·유형 오류)가 있으면 "revise" 또는 "reclassify"
· patch로 다 고쳤으면 "approve"
· 점수는 0~100. 후하게 주지 말 것. 환각이 하나라도 있으면 faithfulness는 60 이하.

── patch 작성법 ──
· path는 값의 경로. 예: "myRole", "tasks[0].metrics", "period.start"
· valueJson은 넣을 값을 **JSON으로 인코딩한 문자열**. 예: "\\"백엔드 API 설계\\"", "null", "[\\"Python\\"]"
· 비워야 하면 valueJson을 "null"로. 고칠 게 없으면 patch는 빈 배열.
· comment는 한국어 3~5문장으로 무엇이 문제였고 무엇을 고쳤는지."""

SUPERVISE_SCHEMA = {"type": "OBJECT", "properties": {
    "verdict": {"type": "STRING", "description": "approve | revise | reclassify"},
    "scores": {"type": "OBJECT", "properties": {
        "classification": {"type": "NUMBER"}, "coverage": {"type": "NUMBER"},
        "faithfulness": {"type": "NUMBER"}, "formatting": {"type": "NUMBER"}},
        "propertyOrdering": ["classification", "coverage", "faithfulness", "formatting"]},
    "issues": {"type": "ARRAY", "items": {"type": "OBJECT", "properties": {
        "severity": {"type": "STRING", "description": "blocker | major | minor"},
        "type": {"type": "STRING",
                 "description": "hallucination | misplaced | format | summary_drift | duplication | missing_required | wrong_type"},
        "path": {"type": "STRING"},
        "detail": {"type": "STRING", "description": "한국어. 원문을 인용해 설명."}},
        "propertyOrdering": ["severity", "type", "path", "detail"]}},
    "reclassifyTo": {"type": "STRING", "nullable": True},
    "patch": {"type": "ARRAY", "items": {"type": "OBJECT", "properties": {
        "path": {"type": "STRING"}, "valueJson": {"type": "STRING"}, "note": {"type": "STRING"}},
        "propertyOrdering": ["path", "valueJson", "note"]}},
    "comment": {"type": "STRING"},
}, "propertyOrdering": ["verdict", "scores", "issues", "reclassifyTo", "patch", "comment"]}


def supervise(g: Gemini, t: dict, draft: dict, docs: List[dict], vissues: List[dict],
              evidence_text: str = "", fs_text: str = "") -> dict:
    field_list = "\n".join(
        f"- {f['key']} | {f['label']} — {f['kind']}"
        f"{' 〔' + '·'.join(f['options']) + '〕' if f.get('options') else ''}"
        f"{' (필수)' if f.get('req') else ''}" for f in all_fields(t))
    system = (f"{SUPERVISE_SYSTEM}\n\n── 검수 대상 유형: {t['emoji']} {t['label']} ({t['id']}) ──\n{field_list}")

    vrep = "\n".join(f"[{i['severity']}/{i['type']}] {i['path']} — {i['detail']}"
                     for i in vissues) or "(기계 검증기가 찾은 문제 없음)"
    prep = "\n".join(
        f"· {p['path']} (신뢰도 {p['confidence']*100:.0f}%) ← " +
        " / ".join(f"[{q['sourceId']}] \"{q['text'][:120]}\"" for q in p["quotes"])
        for p in draft["provenance"]) or "(근거 없음 — 이 자체가 문제다)"
    unf = "\n".join(f"· {u['label']} ({u['path']}) — {u['reason']}" for u in draft["unfilled"]) or "(없음)"

    parts = []
    if fs_text:
        parts.append({"text": f"## 원문에서 뽑은 사실 시트\n{fs_text}"})
    parts.append({"text": "## 원문 근거 구간 (정리된 값과 관련된 부분만 발췌)\n"
                          + (evidence_text or evidence_bundle(docs))})
    parts.append({"text": "## 정리 결과 (검수 대상)\n```json\n"
                          + json.dumps(draft["values"], ensure_ascii=False, indent=2) + "\n```"})
    parts.append({"text": f"## 값별 근거\n{prep}"})
    parts.append({"text": f"## 비워 둔 항목\n{unf}"})
    parts.append({"text": f"## 기계 검증기 결과\n{vrep}"})

    r = g.structured("supervise", parts, system, SUPERVISE_SCHEMA,
                     max_tokens=24000, thinking=-1)

    patch = {}
    for p in (r.get("patch") or []):
        if not p.get("path"): continue
        try: patch[p["path"]] = json.loads(p.get("valueJson", "null"))
        except json.JSONDecodeError: patch[p["path"]] = p.get("valueJson")

    return {"verdict": r.get("verdict", "approve"),
            "scores": r.get("scores") or {},
            "issues": vissues + [dict(i, foundBy="supervisor") for i in (r.get("issues") or [])],
            "reclassifyTo": r.get("reclassifyTo"),
            "patch": patch, "comment": r.get("comment", "")}


GUIDE_SYSTEM = """당신은 ARC 경험 기록 서비스의 **Fallback 안내 에이전트**다.
자동 정리 후 **비어 있는 항목**을 보고, 사용자가 무엇을 더 주면 채울 수 있는지 안내한다.

1. 사용자를 탓하지 않는다. "자료가 부족합니다"가 아니라 "○○을 알려주시면 △△칸이 채워집니다".
2. 각 항목마다 **구체적으로 무엇을** 주면 되는지 적는다.
   나쁜 예: "성과를 입력해주세요"
   좋은 예: "이 캠페인으로 팔로워가 몇 명 늘었는지 숫자로 알려주세요.
             주최 측 결과 리포트가 있으면 그 파일을 올려주셔도 됩니다."
3. question은 사용자에게 그대로 보여줄 **한 문장 질문**. 존댓말, 40자 내외.
4. priority — 필수 항목과 이 경험의 가치를 보여주는 항목(성과·내 역할·기간)은 high.
5. nextQuestions에는 **가장 효율적인 질문 3~5개**만. 하나의 답으로 여러 칸이 채워지는 질문을 우선.
6. recommendedUploads에는 이 유형에서 흔히 빈칸을 메워주는 파일 종류를 적는다.
7. 모든 출력은 한국어."""

GUIDE_SCHEMA = {"type": "OBJECT", "properties": {
    "missing": {"type": "ARRAY", "items": {"type": "OBJECT", "properties": {
        "path": {"type": "STRING"}, "why": {"type": "STRING"},
        "whatToProvide": {"type": "STRING"}, "question": {"type": "STRING"},
        "priority": {"type": "STRING", "description": "high | medium | low"}},
        "propertyOrdering": ["path", "why", "whatToProvide", "question", "priority"]}},
    "recommendedUploads": {"type": "ARRAY", "items": {"type": "STRING"}},
    "nextQuestions": {"type": "ARRAY", "items": {"type": "STRING"}},
}, "propertyOrdering": ["missing", "recommendedUploads", "nextQuestions"]}


def empty_paths(t: dict, values: dict) -> List[dict]:
    out = []
    def walk(fields, prefix=""):
        for f in fields:
            path = f"{prefix}.{f['key']}" if prefix else f["key"]
            v = get_path(values, path)
            if f["kind"] == "repeater":
                if _blank(v):
                    out.append({"path": path, "label": label_for_path(t, path),
                                "req": f.get("req", False), "kind": f["kind"]})
                elif isinstance(v, list):
                    for i in range(len(v)): walk(f.get("fields", []), f"{path}[{i}]")
                continue
            if _blank(v):
                out.append({"path": path, "label": label_for_path(t, path),
                            "req": f.get("req", False), "kind": f["kind"]})
    walk(all_fields(t))
    return out


def completeness(t: dict, values: dict) -> int:
    total = filled = 0
    for f in all_fields(t):
        w = 3 if f.get("req") else 1
        total += w
        if not _blank(get_path(values, f["key"])): filled += w
    return round(filled / total * 100) if total else 0


def build_guide(g: Gemini, t: dict, draft: dict, docs: List[dict], cls: dict) -> dict:
    empties = empty_paths(t, draft["values"])
    score = completeness(t, draft["values"])
    base = {"completeness": score, "missing": [], "recommendedUploads": [], "nextQuestions": []}

    if cls.get("confidence", 1) < 0.55:
        cands = [{"typeId": cls["typeId"], "label": TYPE_BY_ID[cls["typeId"]]["label"]}]
        for a in cls.get("alternatives", [])[:2]:
            if a.get("typeId") in TYPE_BY_ID:
                cands.append({"typeId": a["typeId"], "label": TYPE_BY_ID[a["typeId"]]["label"]})
        base["confirmType"] = {"candidates": cands,
                               "question": f"이 활동이 '{cands[0]['label']}'이 맞나요? 아니라면 골라주세요."}
    if not empties: return base

    reasons = {u["path"]: u["reason"] for u in draft["unfilled"]}
    listing = "\n".join(
        f"- {e['path']} | {e['label']} ({e['kind']}{', 필수' if e['req'] else ''})"
        + (f" ← 추출기 메모: {reasons[e['path']]}" if e["path"] in reasons else "")
        for e in empties)

    r = g.structured("guide", [
        {"text": "## 사용자가 올린 자료\n" + "\n".join(f"- {d['name']} ({d['kind']})" for d in docs)},
        {"text": f"## 지금까지 채워진 내용 (채움률 {score}%)\n```json\n"
                 + json.dumps(draft["values"], ensure_ascii=False, indent=2) + "\n```"},
        {"text": f"## 비어 있는 항목 ({len(empties)}개)\n{listing}"},
    ], f"{GUIDE_SYSTEM}\n\n── 대상 유형: {t['emoji']} {t['label']} ({t['id']}) ──",
       GUIDE_SCHEMA, max_tokens=12000, thinking=0, light=True)

    labels = {e["path"]: e["label"] for e in empties}
    rank = {"high": 2, "medium": 1, "low": 0}
    missing = [dict(m, label=labels.get(m.get("path"), label_for_path(t, m.get("path", ""))))
               for m in (r.get("missing") or []) if m.get("path")]
    missing.sort(key=lambda m: -rank.get(m.get("priority", "low"), 0))
    base.update({"missing": missing,
                 "recommendedUploads": r.get("recommendedUploads") or [],
                 "nextQuestions": (r.get("nextQuestions") or [])[:5]})
    return base


# ==============================================================================
#  5. 결정론적 검증기 — 감독에게 넘기기 전에 기계가 잡을 수 있는 건 기계가 잡는다
# ==============================================================================

DATE_RE = re.compile(r"^(19|20)\d{2}(-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?)?$")
URL_RE = re.compile(r"^(https?://|www\.)\S+$", re.I)
COMMON_LATIN = {"and", "the", "for", "with", "from", "team", "project", "data", "web", "app",
                "api", "ui", "ux", "pm", "qa", "ai", "ml", "it", "hr", "ceo", "cto", "kpi",
                "roi", "pdf", "png", "jpg", "url", "http", "https", "www", "com", "net", "org"}


def validate_structure(t: dict, values: dict) -> List[dict]:
    issues = []
    def add(sev, typ, path, detail):
        issues.append({"severity": sev, "type": typ, "path": path,
                       "detail": detail, "foundBy": "validator"})

    def walk(fields, obj, prefix=""):
        for f in fields:
            path = f"{prefix}.{f['key']}" if prefix else f["key"]
            v = obj.get(f["key"]) if isinstance(obj, dict) else None
            label = label_for_path(t, path)
            if f.get("req") and _blank(v):
                add("blocker", "missing_required", path, f"필수 항목 '{label}'이 비어 있습니다.")
                continue
            if _blank(v): continue
            k = f["kind"]
            if k == "date" and not DATE_RE.match(str(v).strip()):
                add("major", "format", path, f"'{label}'의 날짜 형식 오류: {v} (YYYY-MM-DD)")
            elif k == "daterange" and isinstance(v, dict):
                for key, ko in (("start", "시작"), ("end", "종료")):
                    if v.get(key) and not DATE_RE.match(str(v[key]).strip()):
                        add("major", "format", f"{path}.{key}", f"'{label}'의 {ko}일 형식 오류: {v[key]}")
                if v.get("start") and v.get("end") and str(v["start"]) > str(v["end"]):
                    add("major", "format", path, f"'{label}' 시작일이 종료일보다 뒤입니다 ({v['start']} > {v['end']}).")
                if v.get("ongoing") and v.get("end"):
                    add("minor", "format", path, f"'{label}'이 진행 중인데 종료일이 있습니다.")
            elif k == "select" and f.get("options") and str(v) not in f["options"]:
                add("major", "format", path,
                    f"'{label}'의 값 \"{v}\"은 보기에 없습니다. 보기: {', '.join(f['options'])}")
            elif k == "checklist" and f.get("options") and not f.get("free"):
                bad = [x for x in (v if isinstance(v, list) else []) if x not in f["options"]]
                if bad: add("major", "format", path, f"'{label}'에 보기에 없는 값: {', '.join(map(str, bad))}")
            elif k == "tags" and isinstance(v, list) and len(v) > 20:
                add("minor", "format", path, f"'{label}' 태그가 {len(v)}개로 과합니다.")
            elif k == "link" and not URL_RE.match(str(v).strip()):
                add("minor", "format", path, f"'{label}'이 URL 형식이 아닙니다: {v}")
            elif k == "text":
                if "\n" in str(v):
                    add("minor", "format", path, f"'{label}'은 한 줄 입력인데 줄바꿈이 있습니다.")
                if f["key"] in ("summary", "oneLiner") and len(str(v)) > 120:
                    add("minor", "format", path, f"'{label}'이 {len(str(v))}자로 깁니다. 80자 내외로.")
            elif k == "longtext" and len(str(v).strip()) < 5:
                add("minor", "format", path, f"'{label}'의 내용이 너무 짧습니다. 비우거나 제대로 채우세요.")
            elif k == "repeater" and isinstance(v, list):
                for i, row in enumerate(v): walk(f.get("fields", []), row, f"{path}[{i}]")
    walk(all_fields(t), values)
    return issues


def check_grounding(t: dict, values: dict, provenance: List[dict],
                    docs: List[dict], index=None) -> List[dict]:
    """환각 탐지 — RAGKOR 기반.

    예전에는 `정규화(quote) in 정규화(원문)` 이었다. 모델이 인용을 조금만 다듬어도
    (말줄임표, 표 재구성, 페이지 머리말) 전부 환각으로 튀었고, 그 오탐이 감독에게
    흘러가 재작업을 유발했다. 지금은 n-gram 국소 밀도로 '원문 어딘가에 이어진
    형태로 존재하는가'를 재고, 수치는 원문값/파생값/근거없음 3단으로 가른다.
    """
    idx = index or SourceIndex([d["text"] for d in docs])
    issues, seen = [], set()
    names = [d["name"] for d in docs]

    def add(sev, path, detail, typ="hallucination"):
        k = (path, detail)
        if k in seen:
            return
        seen.add(k)
        issues.append({"severity": sev, "type": typ, "path": path,
                       "detail": detail, "foundBy": "validator"})

    # 1) 근거 문장이 원문에 실제로 있는가
    for p in provenance:
        for q in p["quotes"]:
            r = idx.verify_quote(q["text"])
            if r["verdict"] == "ungrounded":
                add("blocker", p["path"],
                    f"'{label_for_path(t, p['path'])}'의 근거 문장이 원문에서 확인되지 않습니다"
                    f"(일치도 {r['score']:.0%}): \"{q['text'][:60]}\"")
            elif r["verdict"] == "weak":
                add("minor", p["path"],
                    f"'{label_for_path(t, p['path'])}'의 근거가 원문과 부분적으로만 일치합니다"
                    f"(일치도 {r['score']:.0%}). 표현이 바뀌었는지 확인하세요.")

    prov_paths = [p["path"] for p in provenance]
    for path in leaf_paths(values):
        v = get_path(values, path)
        if not isinstance(v, str) or not v.strip():
            continue
        key = re.sub(r"\[\d+\]$", "", path.split(".")[-1])

        # 2) 파일 항목은 업로드 목록과 대조
        if re.search(r"evidence|certificate|file|transcript|screenshot|submission|artifact|attachment",
                     key, re.I):
            if not any(n in v or v in n for n in names):
                add("major", path,
                    f"'{label_for_path(t, path)}'의 파일명 \"{v}\"이 업로드 목록에 없습니다. "
                    f"업로드: {', '.join(names)}")
            continue

        # 3) 수치 — 원문값 / 파생값 / 근거없음
        for raw in re.findall(r"\d[\d,]*(?:\.\d+)?", v):
            if len(raw.replace(",", "")) < 2:
                continue
            kind = idx.classify_number(raw)
            if kind == "unknown":
                add("major", path,
                    f"'{label_for_path(t, path)}'의 수치 \"{raw}\"가 원문에서 확인되지 않습니다. "
                    f"원문에 없는 숫자는 빼야 합니다.")
            # derived(원문 수치에서 계산된 값)는 통과시킨다 — 예전엔 이것까지 환각으로 지웠다

        # 4) 고유명사·용어 — 유의어와 오타를 허용하고도 못 찾을 때만 지적
        for tok in re.findall(r"[A-Za-z][A-Za-z0-9+#.]{2,}|[가-힣]{3,}", v):
            if tok.lower() in COMMON_LATIN or tok in STOPWORDS:
                continue
            if not idx.check_term(tok):
                add("minor", path,
                    f"'{label_for_path(t, path)}'의 \"{tok}\"이 원문에서 확인되지 않습니다.")

        # 5) 근거가 아예 없는 긴 값
        if len(v.strip()) > 25 and not any(path.startswith(pp) or pp.startswith(path)
                                           for pp in prov_paths):
            add("minor", path,
                f"'{label_for_path(t, path)}'에 근거(quote)가 붙어 있지 않습니다.")
    return issues


# ==============================================================================
#  5-b. 사실 시트 · 앙상블 · 결정론적 병합 — 품질을 올리면서 비용을 내리는 부분
# ==============================================================================

FACTSHEET_SYSTEM = """당신은 문서에서 **사실만** 뽑아내는 정리자다.
해석·요약·평가를 하지 말고, 나중에 누가 읽어도 원문을 재구성할 수 있는 '사실 시트'를 만든다.

── 반드시 지킬 것 ──
1. **문서 전체를 끝까지 읽는다.** 앞부분만 보고 판단하지 않는다.
2. 오타·비문·구어체가 있어도 **맥락으로 의미를 복원**한다.
   '개꿀', '빡셈', '삽질', '갈아넣었다' 같은 말도 무슨 뜻인지 파악해 normalized에 적는다.
   원문 표기는 as_written에 그대로 남긴다. 임의로 고쳐 쓰지 않는다.
3. **숫자는 하나도 빠뜨리지 않는다.** 각 숫자가 무엇을 가리키는지 context에 적는다.
   비교·증감이 있으면 before/after를 나눠 적는다 (예: 820ms → 210ms).
4. 사람·조직·제품·도구·장소 이름을 원문 표기 그대로 모은다.
5. '내가 한 일'과 '팀/회사가 한 일'을 구분해 적는다. 원문이 모호하면 unclear에 넣는다.
6. 문서 성격(register)을 판정한다: 공식문서 / 보고서 / 메모 / 일기 / 대화기록 / 이력서.
7. 원문에 없는 내용을 만들지 않는다. 추론한 것은 전부 inferred=true로 표시한다."""

FACTSHEET_SCHEMA = {"type": "OBJECT", "properties": {
    "docType": {"type": "STRING", "description": "문서 성격 (공식문서/보고서/메모/일기/대화기록/이력서/기타)"},
    "register": {"type": "STRING", "description": "문체 (격식체/평서체/구어체/혼합)"},
    "title": {"type": "STRING", "nullable": True, "description": "문서가 다루는 활동의 이름"},
    "outline": {"type": "ARRAY", "description": "섹션별 한 줄 요약. 순서대로.",
        "items": {"type": "OBJECT", "properties": {
            "heading": {"type": "STRING"}, "summary": {"type": "STRING"}},
            "propertyOrdering": ["heading", "summary"]}},
    "entities": {"type": "OBJECT", "properties": {
        "people": {"type": "ARRAY", "items": {"type": "STRING"}},
        "orgs": {"type": "ARRAY", "items": {"type": "STRING"}},
        "products": {"type": "ARRAY", "items": {"type": "STRING"}},
        "tools": {"type": "ARRAY", "items": {"type": "STRING"}}},
        "propertyOrdering": ["people", "orgs", "products", "tools"]},
    "numbers": {"type": "ARRAY", "description": "문서의 모든 수치. 빠뜨리지 말 것.",
        "items": {"type": "OBJECT", "properties": {
            "value": {"type": "STRING"}, "unit": {"type": "STRING", "nullable": True},
            "context": {"type": "STRING", "description": "이 숫자가 무엇을 가리키는지"},
            "before": {"type": "STRING", "nullable": True},
            "after": {"type": "STRING", "nullable": True}},
            "propertyOrdering": ["value", "unit", "context", "before", "after"]}},
    "dates": {"type": "ARRAY", "items": {"type": "OBJECT", "properties": {
        "value": {"type": "STRING"}, "context": {"type": "STRING"}},
        "propertyOrdering": ["value", "context"]}},
    "myActions": {"type": "ARRAY", "description": "'내가' 한 일. 원문 표현을 살릴 것.",
        "items": {"type": "STRING"}},
    "teamActions": {"type": "ARRAY", "description": "팀/회사/타인이 한 일", "items": {"type": "STRING"}},
    "unclear": {"type": "ARRAY", "description": "주어가 모호해 판단이 안 되는 것", "items": {"type": "STRING"}},
    "achievements": {"type": "ARRAY", "description": "성과·결과. 수치가 있으면 함께.",
        "items": {"type": "STRING"}},
    "problems": {"type": "ARRAY", "description": "문제·한계·어려움과 그 대응", "items": {"type": "STRING"}},
    "learnings": {"type": "ARRAY", "description": "배운 점·회고", "items": {"type": "STRING"}},
    "links": {"type": "ARRAY", "items": {"type": "STRING"}},
    "normalized": {"type": "ARRAY",
        "description": "오타·구어·줄임말을 표준 표현으로 옮긴 기록",
        "items": {"type": "OBJECT", "properties": {
            "as_written": {"type": "STRING"}, "meaning": {"type": "STRING"}},
            "propertyOrdering": ["as_written", "meaning"]}},
}, "propertyOrdering": ["docType", "register", "title", "outline", "entities", "numbers",
                        "dates", "myActions", "teamActions", "unclear", "achievements",
                        "problems", "learnings", "links", "normalized"]}


def build_factsheet(g: Gemini, docs: List[dict]) -> dict:
    """문서 → 사실 시트. 값싼 모델 1회로 만들고 이후 모든 단계가 재사용한다.

    이게 있으면 뒤 단계에 원문 전체를 반복해서 밀어 넣을 필요가 줄고,
    무엇보다 **수치와 고유명사의 누락**이 크게 준다. 오타·구어도 여기서 한 번 걸러진다.
    """
    return g.structured("factsheet", [{"text": evidence_bundle(docs)}],
                        FACTSHEET_SYSTEM, FACTSHEET_SCHEMA,
                        max_tokens=16000, thinking=0, light=True)


def factsheet_text(fs: dict) -> str:
    """사실 시트를 프롬프트에 넣을 텍스트로."""
    if not fs:
        return ""
    L = []
    L.append(f"문서 성격: {fs.get('docType','?')} / 문체: {fs.get('register','?')}")
    if fs.get("title"):
        L.append(f"활동명 후보: {fs['title']}")
    if fs.get("outline"):
        L.append("구성: " + " | ".join(f"{o.get('heading','')}={o.get('summary','')}"
                                      for o in fs["outline"][:20]))
    ent = fs.get("entities") or {}
    for k, ko in (("orgs", "조직"), ("people", "사람"), ("products", "제품"), ("tools", "도구")):
        if ent.get(k):
            L.append(f"{ko}: {', '.join(ent[k][:15])}")
    if fs.get("dates"):
        L.append("날짜: " + " / ".join(f"{d.get('value')}({d.get('context','')})"
                                     for d in fs["dates"][:15]))
    if fs.get("numbers"):
        L.append("수치(원문 근거 있음):")
        for n in fs["numbers"][:40]:
            ba = ""
            if n.get("before") or n.get("after"):
                ba = f" [{n.get('before','?')} → {n.get('after','?')}]"
            L.append(f"  · {n.get('value')}{n.get('unit') or ''} — {n.get('context','')}{ba}")
    for k, ko in (("myActions", "내가 한 일"), ("teamActions", "팀이 한 일"),
                  ("achievements", "성과"), ("problems", "문제·한계"),
                  ("learnings", "배운 점"), ("unclear", "주어 불명")):
        if fs.get(k):
            L.append(f"{ko}: " + " / ".join(fs[k][:15])) 
    if fs.get("links"):
        L.append("링크: " + ", ".join(fs["links"][:10]))
    if fs.get("normalized"):
        L.append("표기 정규화: " + ", ".join(f"{x.get('as_written')}→{x.get('meaning')}"
                                          for x in fs["normalized"][:20]))
    return "\n".join(L)


# ── 앙상블 결과 병합 (LLM 호출 0회) ─────────────────────────────────────

def _prov_for(prov: List[dict], path: str) -> List[dict]:
    return [p for p in prov if p["path"] == path or p["path"].startswith(path + "[")
            or p["path"].startswith(path + ".")]


def _field_score(t: dict, f: dict, value, prov: List[dict], idx) -> float:
    """이 값이 '원문에 근거하고 구체적인가'를 0~4 점수로."""
    if _blank(value):
        return -1.0
    score = 0.0
    quotes = [q for p in _prov_for(prov, f["key"]) for q in p["quotes"]]
    if quotes:
        gs = [idx.verify_quote(q["text"])["score"] for q in quotes]
        score += 2.0 * (sum(gs) / len(gs))
    else:
        score += 0.8                                  # 근거 미제출은 중간 취급
    flat = json.dumps(value, ensure_ascii=False)
    nums = re.findall(r"\d[\d,]*(?:\.\d+)?", flat)
    good = sum(1 for n in nums if idx.classify_number(n) in ("literal", "derived"))
    bad = len(nums) - good
    score += min(0.8, 0.2 * good) - 1.2 * bad         # 근거 없는 숫자는 강하게 감점
    if f["kind"] == "repeater" and isinstance(value, list):
        filled = sum(1 for row in value if isinstance(row, dict)
                     and sum(1 for v in row.values() if not _blank(v)) >= 2)
        score += min(1.0, 0.25 * filled)              # 여러 건으로 잘 쪼갰으면 가점
    elif f["kind"] == "longtext" and isinstance(value, str):
        n = len(value.strip())
        score += 0.4 if 30 <= n <= 800 else (-0.4 if n < 15 else 0.0)
    return score


def merge_drafts(t: dict, drafts: List[dict], idx) -> Tuple[dict, List[dict], List[dict]]:
    """여러 추출 결과에서 **필드별로 더 나은 쪽**만 골라 합친다.

    '좋은 부분만 합친다'는 게 핵심이다. 값싼 모델 두 번의 합집합이
    비싼 모델 한 번보다 나은 경우가 많다 — 서로 놓친 항목이 다르기 때문이다.
    """
    fields = all_fields(t)
    merged: dict = {}
    prov_out: List[dict] = []
    conflicts: List[dict] = []

    for f in fields:
        key = f["key"]
        cands = []
        for d in drafts:
            v = (d.get("values") or {}).get(key)
            cands.append((v, _field_score(t, f, v, d.get("provenance", []), idx), d))
        cands.sort(key=lambda c: -c[1])
        best_v, best_s, best_d = cands[0]

        if _blank(best_v):
            merged[key] = None
            continue

        # repeater는 '고른다'가 아니라 '합친다' — 서로 다른 건을 잡았을 수 있다
        if f["kind"] == "repeater":
            merged[key] = _merge_rows(f, [c[0] for c in cands if isinstance(c[0], list)])
        else:
            merged[key] = best_v
            others = [c for c in cands[1:] if not _blank(c[0]) and c[0] != best_v]
            if others and abs(others[0][1] - best_s) < 0.25:
                conflicts.append({"key": key, "label": f["label"], "kind": f["kind"],
                                  "options": [best_v, others[0][0]]})

        for p in _prov_for(best_d.get("provenance", []), key):
            prov_out.append(p)

    return merged, prov_out, conflicts


def _merge_rows(f: dict, lists: List[list]) -> Optional[list]:
    """반복 입력 행 합치기 — 첫 번째 필수 칸을 키로 중복을 제거하고 더 꽉 찬 행을 남긴다."""
    subs = f.get("fields", [])
    keyfield = next((x["key"] for x in subs if x.get("req")), subs[0]["key"] if subs else None)
    if not keyfield:
        return lists[0] if lists else None
    bucket: Dict[str, dict] = {}
    for lst in lists:
        for row in lst or []:
            if not isinstance(row, dict):
                continue
            k = fold(str(row.get(keyfield) or ""))
            if not k:
                continue
            filled = sum(1 for v in row.values() if not _blank(v))
            if k not in bucket or filled > bucket[k]["_n"]:
                bucket[k] = dict(row, _n=filled)
            else:                                      # 같은 행이면 빈 칸만 채워 넣는다
                for sk, sv in row.items():
                    if _blank(bucket[k].get(sk)) and not _blank(sv):
                        bucket[k][sk] = sv
    rows = [{k: v for k, v in r.items() if k != "_n"} for r in bucket.values()]
    return rows or None


ARBITER_SYSTEM = """두 개의 정리 결과가 같은 항목에서 다른 값을 냈다.
원문 근거만 보고 **어느 쪽이 맞는지** 고르거나, 둘을 합친 더 정확한 값을 쓴다.

1. 원문에 근거가 있는 쪽을 고른다. 둘 다 근거가 있으면 더 구체적인 쪽(수치·고유명사 포함).
2. 한쪽이 과장·왜곡이면(참여→주도, 시도→달성) 보수적인 쪽을 고른다.
3. 둘 다 부정확하면 choice="neither" 로 두고 비운다.
4. 합치는 게 나으면 choice="merged" 와 merged 값을 쓴다. 원문에 없는 말을 보태지 않는다."""

ARBITER_SCHEMA = {"type": "OBJECT", "properties": {
    "decisions": {"type": "ARRAY", "items": {"type": "OBJECT", "properties": {
        "key": {"type": "STRING"},
        "choice": {"type": "STRING", "description": "A | B | merged | neither"},
        "merged": {"type": "STRING", "nullable": True},
        "reason": {"type": "STRING"}},
        "propertyOrdering": ["key", "choice", "merged", "reason"]}},
}, "propertyOrdering": ["decisions"]}


def arbitrate(g: Gemini, t: dict, conflicts: List[dict], fs_text: str, idx) -> dict:
    """충돌 필드만 골라 값싼 모델 1회로 중재한다. 전체 문서를 다시 보낼 필요가 없다."""
    if not conflicts:
        return {}
    lines = []
    for c in conflicts[:12]:
        a, b = c["options"]
        lines.append(f"[{c['key']}] {c['label']} ({c['kind']})\n  A: "
                     f"{json.dumps(a, ensure_ascii=False)[:500]}\n  B: "
                     f"{json.dumps(b, ensure_ascii=False)[:500]}")
    r = g.structured("arbitrate", [
        {"text": f"## 원문에서 뽑은 사실\n{fs_text}"},
        {"text": "## 판단할 충돌 항목\n" + "\n\n".join(lines)},
    ], ARBITER_SYSTEM, ARBITER_SCHEMA, max_tokens=8000, thinking=0, light=True)

    out = {}
    by_key = {c["key"]: c for c in conflicts}
    for d in (r.get("decisions") or []):
        c = by_key.get(d.get("key"))
        if not c:
            continue
        ch = (d.get("choice") or "A").upper()
        if ch == "A":
            out[c["key"]] = c["options"][0]
        elif ch == "B":
            out[c["key"]] = c["options"][1]
        elif ch.lower() == "merged" and d.get("merged"):
            out[c["key"]] = d["merged"]
        elif ch.lower() == "neither":
            out[c["key"]] = None
    return out


# ── 감독용 근거 압축 — 전체 문서 대신 '관련 구간'만 보낸다 ──────────────────

def evidence_spans(docs: List[dict], values: dict, provenance: List[dict],
                   idx, budget: int = 9000) -> str:
    """채워진 값의 근거 주변만 잘라 모은다. 감독 입력이 31k → 9k 로 줄어든다."""
    raw = "\n".join(d["text"] for d in docs)
    folded = idx.folded
    picked: List[Tuple[int, int]] = []

    def mark(needle: str, pad: int = 260):
        f = fold(needle)
        if len(f) < 6:
            return
        pos = folded.find(f[:60])
        if pos < 0:
            grams = ngrams(needle, 4)
            for gtxt in grams[:12]:
                if gtxt in idx.postings:
                    pos = idx.postings[gtxt][0]
                    break
        if pos >= 0:
            ratio = len(raw) / max(1, len(folded))
            c = int(pos * ratio)
            picked.append((max(0, c - pad), min(len(raw), c + len(needle) + pad)))

    for p in provenance:
        for q in p["quotes"]:
            mark(q["text"])
    for path in leaf_paths(values)[:120]:
        v = get_path(values, path)
        if isinstance(v, str) and len(v) > 12:
            mark(v, pad=180)

    if not picked:
        return raw[:budget]
    picked.sort()
    merged: List[List[int]] = []
    for a, b in picked:
        if merged and a <= merged[-1][1] + 120:
            merged[-1][1] = max(merged[-1][1], b)
        else:
            merged.append([a, b])
    out, total = [], 0
    for a, b in merged:
        chunk = raw[a:b]
        if total + len(chunk) > budget:
            chunk = chunk[: max(0, budget - total)]
        if chunk:
            out.append(chunk)
            total += len(chunk)
        if total >= budget:
            break
    return "…\n".join(out)


# ==============================================================================
#  6. 파이프라인
# ==============================================================================

# 감독 재작업 최대 횟수. 검증기 오탐이 사라져 1회로 충분해졌다(예전 기본 2).
MAX_ROUNDS = 1
# 앙상블 시도 횟수. 값싼 모델로 N번 시도해 좋은 부분만 합친다.
ENSEMBLE = 2


def organize(api_key: str, files: List[Tuple[str, bytes]], hint: str = "",
             force_type: str = "", model_pin: str = "", log=print,
             ensemble: int = ENSEMBLE, max_rounds: int = MAX_ROUNDS,
             quality: str = "balanced") -> dict:
    """산출물 파일 → 정리된 ARC 경험 항목.

    ┌ 수집/판독 ─ 사실 시트 ─ 분류 ─┬ 배분 A ┐
    │                              └ 배분 B ┘→ 결정론적 병합 → (충돌만) 중재
    └────────────────────────────────────────→ 감독(근거 구간만) → 안내

    비용 설계
      · 무거운 단계(배분)는 **값싼 모델로 병렬 2회**, 좋은 부분만 골라 합친다.
      · 감독만 상위 모델을 쓰되, 원문 전체가 아니라 **관련 근거 구간**만 본다.
      · 검증기 오탐이 사라져 재작업 루프가 3회 → 1회로 줄었다.
    quality: "fast"(앙상블 1, 전부 flash) / "balanced"(기본) / "best"(배분도 상위 모델)
    """
    g = Gemini(api_key, model_pin)
    main, light = g.models()
    heavy_extract = quality == "best"
    if quality == "fast":
        ensemble = 1
    log(f"  [엔진] gemini — 주 {main} / 보조 {light} (품질 {quality})")

    # ── 0. 수집 ──
    docs: List[dict] = []
    for name, data in files:
        docs += ingest(g, name, data, log)
    for i, d in enumerate(docs, 1):
        d["sourceId"] = f"src{i}"
    if not any(d["text"].strip() for d in docs):
        raise RuntimeError("업로드한 파일에서 텍스트를 하나도 얻지 못했습니다. "
                           "이미지라면 더 선명한 사진을, 문서라면 PDF로 변환해 올려주세요.")
    log(f"  [수집] 문서 {len(docs)}개 / {sum(len(d['text']) for d in docs):,}자")

    idx = SourceIndex([d["text"] for d in docs])

    # ── 1. 사실 시트 + 분류를 한 번에 (병렬) ──
    log("  [정제] 사실 시트 작성 + 유형 판별 (병렬)")
    jobs = [dict(stage="factsheet", parts=[{"text": evidence_bundle(docs)}],
                 system=FACTSHEET_SYSTEM, schema=FACTSHEET_SCHEMA,
                 max_tokens=16000, thinking=0, light=True)]
    if not (force_type and force_type in TYPE_BY_ID):
        listing = "\n".join(f"- {d['name']} ({d['kind']}, {len(d['text']):,}자)" for d in docs)
        body = "\n\n".join(f"[{d['sourceId']} {d['name']}]\n{d['text'][:6000]}" for d in docs)
        cparts = [{"text": f"[업로드된 파일]\n{listing}\n\n[본문 발췌]\n{body}"}]
        if hint:
            cparts.append({"text": f"사용자가 준 추가 맥락: {hint}"})
        jobs.append(dict(stage="classify", parts=cparts, system=CLASSIFY_SYSTEM,
                         schema=CLASSIFY_SCHEMA, max_tokens=8000, thinking=0, light=True))
    results = g.parallel(jobs)

    fs = results[0] if isinstance(results[0], dict) else {}
    if isinstance(results[0], Exception):
        log(f"  [정제] 사실 시트 실패({results[0]}) — 원문만으로 진행합니다")
    fs_text = factsheet_text(fs)
    if fs:
        log(f"  [정제] {fs.get('docType','?')}·{fs.get('register','?')} / "
            f"수치 {len(fs.get('numbers') or [])}건 · 성과 {len(fs.get('achievements') or [])}건 "
            f"· 표기 정규화 {len(fs.get('normalized') or [])}건")

    if force_type and force_type in TYPE_BY_ID:
        cls = {"categoryId": TYPE_BY_ID[force_type]["category"], "typeId": force_type,
               "confidence": 1.0, "rationale": "사용자가 유형을 직접 지정했습니다.",
               "alternatives": [], "multipleExperiences": False}
    else:
        cr = results[1]
        if isinstance(cr, Exception):
            raise cr
        tid = cr.get("typeId")
        if tid not in TYPE_BY_ID:
            tid = next((x["id"] for x in EXPERIENCE_TYPES
                        if x["label"] in str(cr.get("typeId", ""))), "project.personal")
            cr["typeId"] = tid
        cr["categoryId"] = TYPE_BY_ID[tid]["category"]
        cr.setdefault("alternatives", [])
        cr.setdefault("confidence", 0.5)
        cls = cr
    t = TYPE_BY_ID[cls["typeId"]]
    log(f"  [분류] {CAT_BY_ID[t['category']]['label']} › {t['label']} "
        f"(신뢰도 {cls['confidence']*100:.0f}%)")

    # ── 2. 배분 앙상블 (병렬) → 결정론적 병합 → 충돌만 중재 ──
    draft, feedback, history, final, rounds = None, "", [], None, 0
    for rnd in range(max_rounds + 1):
        rounds = rnd + 1
        if draft is None or feedback:
            if ensemble > 1 and not feedback:
                log(f"  [배분] 값싼 모델 {ensemble}회 병렬 시도")
                temps = [0.05, 0.35, 0.6][:ensemble]
                jobs = [dict(kind="raw_extract", temperature=tp) for tp in temps]
                outs = _parallel_extract(g, t, docs, hint, fs_text, temps, heavy_extract)
                drafts = [o for o in outs if isinstance(o, dict)]
                if not drafts:
                    raise RuntimeError(f"배분 실패: {outs[0]}")
                if len(drafts) == 1:
                    draft = drafts[0]
                else:
                    values, prov, conflicts = merge_drafts(t, drafts, idx)
                    log(f"  [병합] 필드별 우수안 선택 · 충돌 {len(conflicts)}건")
                    if conflicts:
                        fixed = arbitrate(g, t, conflicts, fs_text, idx)
                        for k, v in fixed.items():
                            values[k] = v
                        log(f"  [중재] {len(fixed)}건 확정")
                    unfilled = []
                    seen_u = set()
                    for d in drafts:
                        for u in d.get("unfilled", []):
                            if u["path"] in seen_u or not _blank(get_path(values, u["path"])):
                                continue
                            seen_u.add(u["path"])
                            unfilled.append(u)
                    draft = {"values": values, "provenance": prov, "unfilled": unfilled}
            else:
                log(f"  [배분] 재작업 ({rnd + 1}회차)" if feedback else "  [배분] 항목별 배분")
                draft = extract(g, t, docs, hint, feedback, fs_text,
                                light=not heavy_extract)
            feedback = ""

        vissues = validate_structure(t, draft["values"]) + \
                  check_grounding(t, draft["values"], draft["provenance"], docs, idx)
        blockers = sum(1 for i in vissues if i["severity"] == "blocker")
        log(f"  [검증] 기계 검증 {len(vissues)}건 (blocker {blockers})")

        spans = evidence_spans(docs, draft["values"], draft["provenance"], idx)
        log(f"  [감독] 검수 ({rnd + 1}회차) · 근거 {len(spans):,}자로 압축")
        review = supervise(g, t, draft, docs, vissues, spans, fs_text)
        history.append(review); final = review
        sc = review.get("scores", {})
        log(f"  [감독] {review['verdict']} — 충실도 {sc.get('faithfulness', '?')}점, "
            f"이슈 {len(review['issues'])}건")

        if (review["verdict"] == "reclassify" and review.get("reclassifyTo") in TYPE_BY_ID
                and review["reclassifyTo"] != t["id"] and rnd < max_rounds):
            nxt = TYPE_BY_ID[review["reclassifyTo"]]
            log(f"  [분류] 감독이 유형 정정: {t['label']} → {nxt['label']}")
            cls = dict(cls, typeId=nxt["id"], categoryId=nxt["category"],
                       rationale=cls["rationale"] + f"\n[감독 정정] {review['comment']}",
                       alternatives=[{"typeId": t["id"], "confidence": cls["confidence"],
                                      "reason": "최초 분류"}] + cls.get("alternatives", []))
            t, draft, feedback = nxt, None, ""
            continue

        if review["patch"]:
            for pth, v in review["patch"].items():
                try: set_path(draft["values"], pth, v)
                except Exception: pass
            cleared = {pth for pth, v in review["patch"].items() if v in (None, "", [])}
            draft["provenance"] = [x for x in draft["provenance"] if x["path"] not in cleared]
            log(f"  [감독] 수정 {len(review['patch'])}건 적용")

        if review["verdict"] == "approve" or rnd >= max_rounds:
            break
        remaining = [i for i in review["issues"]
                     if i.get("severity") == "blocker" and i.get("path") not in review["patch"]]
        if not remaining:
            break
        feedback = ("이전 회차에서 아래 문제가 발견됐다. 원문을 다시 읽고 정확히 다시 작성하라.\n"
                    + "\n".join(f"· [{i.get('type')}] {i.get('path')} — {i.get('detail')}"
                                for i in remaining)
                    + f"\n\n감독 총평: {review['comment']}")

    final["issues"] = final["issues"] + validate_structure(t, draft["values"])

    # ── 3. Fallback 안내 ──
    log("  [안내] 빈 항목 안내 생성")
    fallback = build_guide(g, t, draft, docs, cls)

    layout, hidden = resolve_layout(t)
    log(f"  [완료] 채움률 {fallback['completeness']}% / "
        f"남은 이슈 {len([i for i in final['issues'] if i.get('severity') != 'minor'])}건")

    return {"category": CAT_BY_ID[t["category"]], "type": t, "classification": cls,
            "values": draft["values"], "layout": layout, "hiddenCommonKeys": hidden,
            "provenance": draft["provenance"], "unfilled": draft["unfilled"],
            "review": {"rounds": rounds, "final": final, "history": history},
            "fallback": fallback, "docs": docs, "factsheet": fs,
            "usage": {**g.usage, "cost": g.usage.get("cost", 0.0)}}


def _parallel_extract(g: Gemini, t: dict, docs: List[dict], hint: str, fs_text: str,
                      temps: List[float], heavy: bool) -> List[Any]:
    """서로 다른 temperature로 동시에 추출한다 — 놓치는 항목이 서로 다르다."""
    from concurrent.futures import ThreadPoolExecutor
    out: List[Any] = [None] * len(temps)

    def one(i: int):
        try:
            out[i] = extract(g, t, docs, hint, "", fs_text,
                             temperature=temps[i], light=not heavy)
        except Exception as e:
            out[i] = e

    with ThreadPoolExecutor(max_workers=len(temps)) as ex:
        list(ex.map(one, range(len(temps))))
    return out


# ==============================================================================
#  7. 프론트 바인딩 형태 + 화면 렌더
# ==============================================================================

def to_form_state(r: dict) -> dict:
    """프론트엔드가 그대로 쓰는 형태 (TS판 toFormState와 동일한 계약)."""
    t = r["type"]
    prov = {p["path"]: p for p in r["provenance"]}
    guide = {m["path"]: m for m in r["fallback"].get("missing", [])}
    fname = {d["sourceId"]: d["name"] for d in r["docs"]}

    def build(f, path, section, zone, collapsed):
        v = get_path(r["values"], path)
        p = prov.get(path)
        out = {"key": f["key"], "label": f["label"], "kind": f["kind"],
               "section": section, "zone": zone, "collapsed": collapsed,
               "required": f.get("req", False), "value": v, "filled": not _blank(v),
               "confidence": p["confidence"] if p else None,
               "evidence": [{"sourceId": q["sourceId"], "fileName": fname.get(q["sourceId"], q["sourceId"]),
                             "text": q["text"]} for q in (p["quotes"] if p else [])]}
        if f.get("options"): out["options"] = f["options"]
        if f.get("free"): out["freeOptions"] = True
        if path in guide:
            gd = guide[path]
            out["guide"] = {"question": gd.get("question", ""),
                            "whatToProvide": gd.get("whatToProvide", ""),
                            "priority": gd.get("priority", "low")}
        if f["kind"] == "repeater":
            out["itemFields"] = [dict(build(s, f"{path}[0].{s['key']}", section, zone, collapsed),
                                      value=None, filled=False, confidence=None, evidence=[])
                                 for s in f.get("fields", [])]
        return out

    sections = [{"title": s["title"], "zone": s["zone"], "collapsed": s["collapsed"],
                 "fields": [build(f, f["key"], s["title"], s["zone"], s["collapsed"])
                            for f in s["fields"]]} for s in r["layout"]]
    fin = r["review"]["final"]
    return {"categoryId": r["category"]["id"], "categoryLabel": r["category"]["label"],
            "typeId": t["id"], "typeLabel": t["label"],
            "typeConfidence": r["classification"].get("confidence", 0),
            "typeRationale": r["classification"].get("rationale", ""),
            "confirmType": r["fallback"].get("confirmType"),
            "values": r["values"], "sections": sections,
            "fields": [f for s in sections for f in s["fields"]],
            "completeness": r["fallback"]["completeness"],
            "questions": r["fallback"].get("nextQuestions", []),
            "recommendedUploads": r["fallback"].get("recommendedUploads", []),
            "warnings": [f"{d['name']}: {w}" for d in r["docs"] for w in d["warnings"]],
            "review": {"verdict": fin["verdict"],
                       "faithfulness": fin.get("scores", {}).get("faithfulness", 0),
                       "attentionFields": [
                           {"label": label_for_path(t, i.get("path", "")), "detail": i.get("detail", "")}
                           for i in fin["issues"] if i.get("severity") != "minor"][:8]},
            "hiddenCommonKeys": r["hiddenCommonKeys"],
            "meta": {"files": [{"name": d["name"], "kind": d["kind"], "chars": len(d["text"]),
                                "confidence": d["confidence"]} for d in r["docs"]],
                     "estimatedCostUsd": r["usage"]["cost"]}}


def _esc(s) -> str:
    return (str(s).replace("&", "&amp;").replace("<", "&lt;")
            .replace(">", "&gt;").replace('"', "&quot;"))


def _fmt(v, kind) -> str:
    if _blank(v): return ""
    if kind == "daterange" and isinstance(v, dict):
        end = "진행 중" if v.get("ongoing") else (v.get("end") or "?")
        return f"{v.get('start') or '?'} ~ {end}"
    if isinstance(v, list):
        if all(isinstance(x, str) for x in v): return ", ".join(v)
        rows = []
        for i, row in enumerate(v, 1):
            cells = " · ".join(f"<b>{_esc(k)}</b> {_esc(x)}"
                               for k, x in row.items() if not _blank(x))
            rows.append(f"<div class='r'><span class='n'>{i}</span>{cells}</div>")
        return "".join(rows)
    return _esc(v).replace("\n", "<br>")


def render_html(form: dict) -> str:
    """Colab 출력창에 실제 폼처럼 보여준다 (프론트가 받는 데이터 그대로 그린 것)."""
    css = """<style>
    .arc{font-family:-apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo','Malgun Gothic',sans-serif;
         max-width:860px;color:#1f2024;line-height:1.6}
    .arc .hd{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:10px}
    .arc .b{background:#f0f0ee;border-radius:99px;padding:4px 11px;font-size:12.5px}
    .arc .b.t{background:#e5edff;color:#2f6df6;font-weight:700}
    .arc .b.ok{color:#1a8a54}.arc .b.w{color:#b4690e}
    .arc .bar{height:6px;background:#eee;border-radius:9px;overflow:hidden;margin:8px 0 18px}
    .arc .bar i{display:block;height:100%;background:#2f6df6}
    .arc section{border:1px solid #e5e5e3;border-radius:11px;padding:14px 16px;margin-bottom:11px;background:#fff}
    .arc h3{font-size:13px;margin:0 0 11px;color:#444;letter-spacing:-.01em}
    .arc .f{margin-bottom:11px}
    .arc .lb{font-size:12px;color:#6b6f76;margin-bottom:3px}
    .arc .lb .a{background:#e3f5eb;color:#1a8a54;border-radius:4px;padding:0 5px;font-size:10.5px;margin-left:5px}
    .arc .lb .s{color:#9a9ea6;font-size:10.5px;margin-left:5px;border-bottom:1px dotted #bbb;cursor:help}
    .arc .lb .rq{color:#d1453b;margin-left:2px}
    .arc .v{border:1px solid #e5e5e3;border-radius:7px;padding:7px 10px;background:#fbfbfa;font-size:14px}
    .arc .v.e{border-style:dashed;color:#b4690e;background:#fffdf7;font-size:12.5px}
    .arc .r{border:1px solid #eee;border-radius:6px;padding:6px 9px;margin:4px 0;background:#fff;font-size:13px}
    .arc .r .n{display:inline-block;min-width:18px;color:#9a9ea6;font-size:11px}
    .arc .ask{background:#f5f8ff;border-color:#cfe0ff}
    .arc .warn{border-color:#f0dcb4;background:#fffdf7}
    .arc .mut{color:#6b6f76;font-size:12.5px}
    .arc ol{margin:0;padding-left:20px}</style>"""

    v = form["review"]["verdict"]
    h = [css, "<div class='arc'>", "<div class='hd'>",
         f"<span class='b t'>{_esc(form['categoryLabel'])} › {_esc(form['typeLabel'])}</span>",
         f"<span class='b'>유형 신뢰도 {form['typeConfidence']*100:.0f}%</span>",
         f"<span class='b {'ok' if v == 'approve' else 'w'}'>검수 {'통과' if v == 'approve' else '수정됨'} "
         f"· 충실도 {form['review']['faithfulness']}</span>",
         f"<span class='b'>채움률 {form['completeness']}%</span>", "</div>",
         f"<p class='mut'>{_esc(form['typeRationale'])}</p>",
         f"<div class='bar'><i style='width:{form['completeness']}%'></i></div>"]

    if form.get("confirmType"):
        cands = " / ".join(_esc(c["label"]) for c in form["confirmType"]["candidates"])
        h.append(f"<section class='ask'><h3>유형 확인이 필요합니다</h3>"
                 f"<p>{_esc(form['confirmType']['question'])}</p><p class='mut'>후보: {cands}</p></section>")

    if form["review"]["attentionFields"]:
        h.append("<section class='warn'><h3>확인해 보세요</h3>" + "".join(
            f"<p class='mut'>· <b>{_esc(a['label'])}</b> — {_esc(a['detail'])}</p>"
            for a in form["review"]["attentionFields"]) + "</section>")

    for s in form["sections"]:
        rows = []
        for f in s["fields"]:
            lb = f"<div class='lb'>{_esc(f['label'])}"
            if f.get("required"): lb += "<span class='rq'>*</span>"
            if f["filled"]: lb += "<span class='a'>자동</span>"
            if f["evidence"]:
                tip = _esc(" / ".join(f"[{e['fileName']}] {e['text']}" for e in f["evidence"])[:400])
                lb += f"<span class='s' title=\"{tip}\">출처 {len(f['evidence'])}</span>"
            lb += "</div>"
            if f["filled"]:
                body = f"<div class='v'>{_fmt(f['value'], f['kind'])}</div>"
            else:
                gd = f.get("guide") or {}
                msg = gd.get("whatToProvide") or gd.get("question") or "비어 있음"
                body = f"<div class='v e'>{_esc(msg)}</div>"
            rows.append(f"<div class='f'>{lb}{body}</div>")
        title = s["title"] + (" (기본 접힘)" if s["collapsed"] else "")
        h.append(f"<section><h3>{_esc(title)}</h3>{''.join(rows)}</section>")

    if form["questions"]:
        h.append("<section class='ask'><h3>이것만 알려주시면 더 채워집니다</h3><ol>"
                 + "".join(f"<li>{_esc(q)}</li>" for q in form["questions"]) + "</ol>"
                 + (f"<p class='mut'>추가로 올리면 좋은 자료: "
                    f"{_esc(', '.join(form['recommendedUploads']))}</p>"
                    if form["recommendedUploads"] else "") + "</section>")

    if form["warnings"]:
        h.append("<section class='warn'><h3>파일 처리 안내</h3>"
                 + "".join(f"<p class='mut'>· {_esc(w)}</p>" for w in form["warnings"]) + "</section>")

    files = "".join(f"<p class='mut'>· {_esc(f['name'])} ({f['kind']}, {f['chars']:,}자, "
                    f"품질 {f['confidence']*100:.0f}%)</p>" for f in form["meta"]["files"])
    h.append(f"<section><h3>처리 정보</h3>{files}"
             f"<p class='mut'>추정 비용 ${form['meta']['estimatedCostUsd']:.4f}</p></section>")
    h.append("</div>")
    return "".join(h)


def show(form: dict):
    try:
        from IPython.display import HTML, display
        display(HTML(render_html(form)))
    except ImportError:
        print(json.dumps(form["values"], ensure_ascii=False, indent=2))


# ==============================================================================
#  8. 실행
# ==============================================================================

SAMPLE_NAME = "샘플_하계인턴십_최종보고서.md"
SAMPLE = """# 하계 인턴십 최종 보고서

- 회사: 주식회사 라온테크
- 소속: 플랫폼개발팀
- 기간: 2024.06.24 ~ 2024.08.30
- 직무: 백엔드 엔지니어링 인턴
- 근무 형태: 주 3일 출근 / 2일 재택

## 1. 지원 동기
대규모 트래픽을 다루는 서비스의 백엔드 구조를 실제로 보고 싶어 지원했습니다.

## 2. 수행 업무

### 2-1. 주문 조회 API 응답 개선 (6/24 ~ 7/19)
- 역할: 단독 담당 (멘토 코드리뷰)
- 기존 주문 조회 API가 N+1 쿼리로 평균 응답 820ms가 나오고 있었습니다.
- JPA fetch join과 Redis 캐시를 적용해 평균 210ms로 줄였습니다.
- 활용 툴: Spring Boot, JPA, Redis, Grafana
- 이슈: 캐시 무효화 시점을 놓쳐 재고 수량이 잠깐 어긋난 적이 있었고,
  주문 이벤트 발행 시점에 캐시를 evict 하도록 바꿔 해결했습니다.

### 2-2. 사내 배치 모니터링 대시보드 (7/22 ~ 8/23)
- 역할: 팀원 2명과 공동 작업, 저는 백엔드 집계 API를 맡았습니다.
- 실패한 배치 잡을 슬랙으로 알림 보내는 기능까지 붙였습니다.
- 도입 후 배치 실패 인지 시간이 평균 40분에서 5분 이내로 줄었습니다.

## 3. 배운 점
성능 문제는 추측이 아니라 측정에서 시작해야 한다는 걸 체감했습니다.

## 4. 종료
인턴 기간 만료로 8월 30일자 종료되었습니다.
"""


def self_test() -> bool:
    """API 키 없이 도는 무결성 검사. 코드가 온전한지 먼저 확인한다."""
    ok, fail = 0, []
    def chk(name, cond):
        nonlocal ok
        if cond: ok += 1
        else: fail.append(name)

    chk("경험 유형 18종", len(EXPERIENCE_TYPES) == 18)
    chk("대분류 4종", len(CATEGORIES) == 4)
    chk("유형 id 중복 없음", len({t["id"] for t in EXPERIENCE_TYPES}) == 18)
    chk("id 접두사 = 대분류", all(t["id"].split(".")[0] == t["category"] for t in EXPERIENCE_TYPES))
    common = {f["key"] for f in BASE_FIELDS + EXTENDED_FIELDS}
    chk("supersedes가 실재 공통항목만 가리킴",
        all(k in common for t in EXPERIENCE_TYPES for k in superseded_keys(t)))
    chk("select에 보기 있음", all(f.get("options") for t in EXPERIENCE_TYPES
                                  for f in t["fields"] if f["kind"] == "select"))
    chk("repeater에 하위칸 있음", all(f.get("fields") for t in EXPERIENCE_TYPES
                                      for f in t["fields"] if f["kind"] == "repeater"))
    chk("18종 전부 레이아웃 전개", all(len(resolve_layout(t)[0]) >= 3 for t in EXPERIENCE_TYPES))

    def walk_schema(n, where):
        assert n["type"] in ("STRING", "NUMBER", "INTEGER", "BOOLEAN", "ARRAY", "OBJECT"), where
        assert "additionalProperties" not in n, where
        for k, v in (n.get("properties") or {}).items(): walk_schema(v, f"{where}.{k}")
        if n.get("items"): walk_schema(n["items"], where + "[]")
    try:
        for t in EXPERIENCE_TYPES: walk_schema(extraction_schema(all_fields(t)), t["id"])
        chk("Gemini 스키마 변환 무결", True)
    except AssertionError as e:
        chk(f"Gemini 스키마 변환 무결 ({e})", False)

    work = TYPE_BY_ID["career.work"]
    chk("경로→라벨", label_for_path(work, "tasks[0].metrics") == "업무내용 > 성과 지표")
    o: dict = {}
    set_path(o, "tasks[1].name", "리팩터링"); set_path(o, "period.start", "2024-03-01")
    chk("경로 읽기/쓰기", get_path(o, "tasks[1].name") == "리팩터링"
        and get_path(o, "period.start") == "2024-03-01")

    iss = validate_structure(work, {
        "companyName": None,
        "employmentPeriod": {"start": "2024-08-01", "end": "2024-03-01", "ongoing": False},
        "employmentType": "알바", "position": "인턴", "jobFunction": "백엔드"})
    kinds = {f"{i['type']}:{i['path']}" for i in iss}
    chk("필수누락 탐지", "missing_required:companyName" in kinds)
    chk("날짜 역전 탐지", "format:employmentPeriod" in kinds)
    chk("보기 위반 탐지", "format:employmentType" in kinds)

    award = TYPE_BY_ID["career.award"]
    docs = [{"sourceId": "src1", "name": "상장.png", "kind": "image",
             "text": "제12회 교내 창업 경진대회 최우수상 수상. 주최: 창업지원단",
             "confidence": .9, "warnings": []}]
    gi = check_grounding(award, {"awardName": "최우수상", "keyAchievement": "참가팀 250팀 중 1위"},
                         [{"path": "awardName", "confidence": .9,
                           "quotes": [{"sourceId": "src1", "text": "최우수상 수상"}]}], docs)
    chk("환각(없는 수치) 탐지", any("250" in i["detail"] for i in gi))
    gi2 = check_grounding(award, {"awardName": "최우수상"},
                          [{"path": "awardName", "confidence": .9,
                            "quotes": [{"sourceId": "src1", "text": "전국 대회에서 대상을 받았습니다"}]}], docs)
    chk("환각(근거 위조) 탐지", any(i["severity"] == "blocker" for i in gi2))

    cv = coerce_values({"employmentType": "인턴십", "companyName": "라온테크",
                        "salary": "해당 없음", "tasks": []}, all_fields(work))
    chk("보기 밖 값 정규화", cv["employmentType"] == "인턴")
    chk("가짜 null 정리", cv["salary"] is None and cv["tasks"] is None)
    chk("누락 키 채움", "position" in cv and cv["position"] is None)

    # ── RAGKOR / 파이프라인 회귀 테스트 ─────────────────────────────
    lex = default_lexicon()
    chk("RAGKOR 사전 1만 건", lex.entries >= 9900)
    chk("유의어 인식(개선↔향상)", lex.canonical("향상") == lex.canonical("개선"))
    chk("신조어 인식(캐리했다↔주도했다)",
        lex.canonical("캐리했다") == lex.canonical("주도했다"))
    chk("오타 복원(프로젝드→프로젝트)",
        lex.fuzzy_canonical("프로젝드")[0] == lex.canonical("프로젝트"))

    doc = ("2.1 이 도메인이 어려운 이유\n"
           "연금 질의는 일반적인 문서 QA와 세 가지 지점에서 다르다.\n"
           "1. 틀린 답이 금전적 손해로 직결된다\n"
           "| 항목 | 값 |\n| Python 모듈 | 62개 |\n| 소스 코드 | 18,799행 |\n"
           "RAG 계층을 개선하여 상품분류 근거 확보율이 32.9%에서 55.7%로 올랐다.")
    si = SourceIndex([doc])
    # 사용자가 실제로 겪은 오탐 — 말줄임표가 붙은 인용
    chk("[회귀] 말줄임표 인용을 환각으로 찍지 않음",
        si.verify_quote("연금 질의는 일반적인 문서 QA와 세 가지 지점에서 다르다. "
                        "1. 틀린 답이 금전적 손해로 직결된다. 2…")["verdict"] != "ungrounded")
    chk("[회귀] 표 재구성 인용 통과",
        si.verify_quote("| 항목 | 값 | | Python 모듈 | 62개 | | 소스 코드 | 18,799행 |"
                        )["verdict"] != "ungrounded")
    chk("[회귀] 유의어로 바꾼 인용 통과",
        si.verify_quote("RAG 계층을 향상하여 상품분류 근거 확보율이 32.9%에서 55.7%로 올랐다"
                        )["verdict"] != "ungrounded")
    chk("진짜 환각은 여전히 잡음",
        si.verify_quote("전국 대회에서 대상을 수상해 상금 5천만원을 받았다")["verdict"] == "ungrounded")
    chk("[회귀] 파생 수치(55.7-32.9=22.8)를 환각으로 안 지움",
        si.classify_number("22.8") == "derived")
    chk("원문 수치는 literal", si.classify_number("18,799") == "literal")
    chk("근거 없는 수치는 unknown", si.classify_number("777") == "unknown")

    award2 = TYPE_BY_ID["career.award"]
    gi3 = check_grounding(award2, {"keyAchievement": "근거 확보율을 22.8%p 높였다"},
                          [{"path": "keyAchievement", "confidence": .9,
                            "quotes": [{"sourceId": "src1",
                                        "text": "상품분류 근거 확보율이 32.9%에서 55.7%로 올랐다"}]}],
                          [{"sourceId": "src1", "name": "d.pdf", "kind": "pdf",
                            "text": doc, "confidence": 1.0, "warnings": []}], si)
    chk("[회귀] 파생 수치 성과가 blocker로 안 찍힘",
        not any(i["severity"] == "blocker" for i in gi3))

    # 앙상블 병합
    work2 = TYPE_BY_ID["career.work"]
    dA = {"values": {"companyName": "라온테크", "keyAchievement": "성능을 개선했다",
                     "tasks": [{"name": "주문 API 개선", "role": "단독"}]},
          "provenance": [{"path": "companyName", "confidence": .9,
                          "quotes": [{"sourceId": "s", "text": "라온테크"}]}], "unfilled": []}
    dB = {"values": {"companyName": "라온테크", "keyAchievement": "응답시간을 820ms에서 210ms로 줄였다",
                     "tasks": [{"name": "배치 모니터링", "role": "공동"}]},
          "provenance": [{"path": "keyAchievement", "confidence": .95,
                          "quotes": [{"sourceId": "s", "text": "820ms"}]}], "unfilled": []}
    si2 = SourceIndex(["라온테크에서 주문 API 응답시간을 820ms에서 210ms로 줄였다. 배치 모니터링도 했다."])
    mv, mp, mc = merge_drafts(work2, [dA, dB], si2)
    chk("[앙상블] 더 구체적인 성과를 고름", "820ms" in str(mv.get("keyAchievement")))
    chk("[앙상블] 반복입력은 합집합으로 병합", len(mv.get("tasks") or []) == 2)

    # 모델 선택: 세대 우선
    chk("[회귀] 최신 세대 우선 선택",
        Gemini._pick(["gemini-2.5-pro", "gemini-2.5-flash", "gemini-3.8-flash"])
        == "gemini-3.8-flash")

    # 근거 구간 압축
    big = ("잡담. " * 400) + "\n핵심 문장: 응답시간을 820ms에서 210ms로 줄였다.\n" + ("잡담. " * 400)
    sp = evidence_spans([{"sourceId": "s", "name": "d.txt", "kind": "text",
                          "text": big, "confidence": 1.0, "warnings": []}],
                        {"keyAchievement": "응답시간을 820ms에서 210ms로 줄였다"},
                        [{"path": "keyAchievement", "confidence": .9,
                          "quotes": [{"sourceId": "s",
                                      "text": "응답시간을 820ms에서 210ms로 줄였다"}]}],
                        SourceIndex([big]), budget=1200)
    chk("[비용] 근거 구간 압축이 원문보다 짧음", len(sp) < len(big) / 2)
    chk("[비용] 압축해도 핵심 문장은 살아 있음", "820ms" in sp)

    chk("모델 자동 선택", Gemini._pick(
        ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-3-pro", "embedding-001"],
        Gemini.PREFER) == "gemini-3-pro")

    print(f"  자체 점검: {ok}개 통과" + (f" / 실패 {len(fail)}개 → {fail}" if fail else ""))
    return not fail


def run(files: Optional[List[Tuple[str, bytes]]] = None, hint: str = "",
        force_type: str = "", show_json: bool = False) -> dict:
    """정리 실행. files=[(파일명, bytes), ...]. 비우면 샘플 문서를 씁니다."""
    if not files:
        files = [(SAMPLE_NAME, SAMPLE.encode("utf-8"))]
        print(f"  (업로드가 없어 샘플 문서로 실행합니다: {SAMPLE_NAME})")
    t0 = time.time()
    r = organize(GOOGLE_API_KEY, files, hint=hint, force_type=force_type, model_pin=GEMINI_MODEL)
    form = to_form_state(r)
    print(f"  소요 {time.time() - t0:.1f}초 · 추정 비용 ${r['usage']['cost']:.4f}\n")
    show(form)
    if show_json:
        print("\n── 프론트엔드로 넘어가는 값(form.values) ──")
        print(json.dumps(form["values"], ensure_ascii=False, indent=2))
    r["form"] = form
    return r


def _upload() -> List[Tuple[str, bytes]]:
    try:
        from google.colab import files as colab_files  # type: ignore
    except ImportError:
        return []
    print("정리할 파일을 선택하세요. (건너뛰려면 '취소')")
    try:
        up = colab_files.upload()
    except Exception:
        return []
    return [(n, b) for n, b in up.items()]


if __name__ == "__main__":
    print("=" * 66)
    print("  ARC 경험 자동 정리 — 테스트")
    print("=" * 66)
    self_test()

    if not GOOGLE_API_KEY.strip():
        print("""
  ⚠ Google API 키가 비어 있습니다.
    1) https://aistudio.google.com/apikey 에서 키 발급 (무료)
    2) 이 셀 맨 위 GOOGLE_API_KEY = "" 안에 붙여넣기
    3) 다시 실행

  키 없이도 위 '자체 점검'은 통과해야 정상입니다(스키마·검증기 무결성 확인).
""")
    else:
        ok, detail = Gemini(GOOGLE_API_KEY, GEMINI_MODEL).verify()
        print(f"  키 확인: {'정상' if ok else '오류'} — {detail}\n")
        if ok:
            RESULT = run(_upload(), hint="")
            print("\n  다시 돌리려면:  run(_upload(), hint='활동 설명')")
            print("  샘플로 돌리려면: run()")
            print("  유형 고정:      run(_upload(), force_type='career.work')")
            print("  전체 결과:      RESULT  /  폼 데이터: RESULT['form']")
