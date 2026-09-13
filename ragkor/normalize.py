"""표기 정규화 — 같은 말을 같은 모양으로 만든다.

근거 검증이 무너지는 이유는 대부분 '의미'가 아니라 '표기'다.
말줄임표 하나, 표 파이프 하나, OCR이 끼워 넣은 페이지 머리말 하나로
exact match가 실패한다. 여기서 그 노이즈를 전부 걷어낸다.
"""
import re
import unicodedata
from typing import List, Set, Tuple

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
