# RAGKOR

한국어 문서에서 **"모델이 말한 것이 원문에 실제로 있는가"** 를 판정하는 어휘 자원 + 매처.

ARC 자동 정리 엔진이 한국어 기술제안서를 처리하다 감독 에이전트가 멀쩡한 인용을
연달아 '환각'으로 찍는 문제에서 출발했다. 원인은 의미가 아니라 **표기**였다.

```python
normalize(quote) in normalize(source)     # 기존 — 말줄임표 하나에 무너진다
```

## 구성

| 파일 | 역할 |
|---|---|
| `jamo.py` | 한글 자모 분해, 두벌식 자판 인접 관계, 가중 편집거리 |
| `normalize.py` | 표기 정규화, 조사/어미 제거, 수치 정규화, 문장 분리 |
| `seed.py` | 사람이 쓴 시드 825개 (의미 클러스터 72 · 표기변이 · 신조어 · 줄임말) |
| `build_lexicon.py` | 시드 → 1만 건 확장 (굴절/접사/오타 규칙, 우선순위 예산제) |
| `match.py` | 사전 조회, 자모 유사도 폴백, 유의어 확장 BM25 |
| `ground.py` | 근거 검증 — n-gram 국소 밀도, 수치 3단 판정 |
| `bench.py` | 벤치마크 |

## 쓰는 법

```bash
python -m ragkor.build_lexicon   # lexicon.json 생성 (0.05초)
python -m ragkor.bench           # 벤치마크
```

```python
from ragkor.ground import SourceIndex

idx = SourceIndex([원문])
idx.verify_quote("...")      # {'score': 0.97, 'verdict': 'grounded'}
idx.classify_number("22.8")  # 'literal' | 'derived' | 'unknown'
idx.check_term("향상")        # 유의어·오타를 허용하고 원문 존재 여부 판정
```

## 성능 (`python -m ragkor.bench`)

| 항목 | 기존 | RAGKOR |
|---|---|---|
| 근거 검증 F1 | 0.918 | **1.000** |
| 정상 인용을 환각으로 오탐 | 21건 / 180 | **0건** |
| 말줄임표 붙은 인용 | 2/23 | **23/23** |
| 오타 복원 (사전 미수록) | — | **93.9%** (49건 중 46) |
| 유의어·신조어 인식 | — | **100%** (24쌍) |
| 수치 판정 (원문/파생/근거없음) | — | **100%** |

알려진 미탐 유형도 함께 측정합니다 — 원문 문장을 그대로 가져와 **엉뚱한 항목에 붙인 경우**는
설계상 통과합니다(감독 에이전트의 몫). 벤치마크가 이를 숨기지 않고 출력합니다.

## TypeScript 포팅

같은 알고리즘·같은 시드의 TS 구현이 `src/ragkor/` 에 있습니다.
시드는 `python tools/gen_seed_ts.py` 로 생성되므로 두 구현이 갈라지지 않습니다.

```bash
npx tsx test/ragkor.test.ts   # 개별 점수(0.86/1.00)까지 Python과 일치하는지 검증
```

## '학습'에 대한 분명한 설명

RAGKOR는 **신경망을 훈련한 모델이 아니다.** 규칙 기반 어휘 자원과 자모 유사도 매처다.
GPU도 코퍼스 라이선스도 필요 없고, 모든 항목이 어느 규칙에서 나왔는지 역추적된다(`origin`).
그래서 틀린 항목을 발견하면 **그 규칙만 고치면 되고 재학습이 필요 없다.**
자세한 근거와 한계는 저장소 루트의 `docs/RAGKOR-report.md` 참고.
