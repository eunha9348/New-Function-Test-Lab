# ARC 경험 자동 정리 엔진

사용자가 **활동 산출물 파일을 올리면**, 그것이 ARC의 어떤 경험 유형인지 스스로 판별하고,
그 유형의 입력 항목에 맞춰 **요약·배분해서 자동으로 채워 넣는** 엔진입니다.

```
파일 업로드
   │
   ├─ ⓪ 수집 / OCR ───── 어떤 형식이든 텍스트로 (PDF·이미지·오피스·한글·음성·영상·압축)
   │
   ├─ ① 분류 에이전트 ─── 대분류 4종 → 세부 유형 18종 판별
   │
   ├─ ② 배분 에이전트 ─── 항목별로 요약해 분배 + 값마다 원문 근거 부착
   │
   ├─ ③ 감독 sub-Agent ── 원문과 대조 검수 → 환각·오배치·왜곡 적발 → 수정 패치
   │        ↕ 재작업 루프 (최대 2회)
   │
   └─ ④ Fallback 안내 ─── 못 채운 칸은 비우고, "무엇을 주면 채워지는지" 질문 생성
```

## 빠른 시작

```bash
npm install
# src/config.ts 의 API_KEYS.anthropic 에 키를 넣거나 .env에 ANTHROPIC_API_KEY 설정

npm run organize -- ./인턴_최종보고서.pdf ./상장.jpg --hint "작년 여름 인턴"
npm run organize -- ./포트폴리오.zip --out result.json
npm run organize -- --list-types        # 18종 유형 목록
npm test                                # API 키 없이 도는 오프라인 검증 16종
```

라이브러리로 쓸 때:

```ts
import { organizeExperience, readInputFiles } from "arc-auto-organize";

const result = await organizeExperience(await readInputFiles(["./보고서.pdf"]), {
  userHint: "동아리에서 한 프로젝트입니다",
  onProgress: (e) => console.log(e.stage, e.message),
});

result.typeLabel;              // "팀 프로젝트"
result.form.values;            // 폼에 그대로 바인딩할 값
result.form.layout;            // 화면 배치(헤더/전용/확장/증빙)
result.provenance;             // 값마다 원문 근거
result.review.final;           // 감독 검수 결과
result.fallback.nextQuestions; // 사용자에게 되물을 질문
```

## ★ API 키 넣는 곳

`src/config.ts` **한 곳**에만 있습니다. 환경변수를 쓰면 그대로 두면 되고, 하드코딩하려면 빈 문자열 자리에 적으면 됩니다.

| 키 | 필요성 | 용도 |
|---|---|---|
| `API_KEYS.anthropic` | **필수** | 분류·배분·감독·Vision OCR |
| `API_KEYS.googleVision` | 선택 | OCR 보조 엔진 (앙상블 정확도 ↑) |
| `API_KEYS.clova` | 선택 | 한국어 문서 특화 OCR 보조 엔진 |
| `API_KEYS.openaiWhisper` | 선택 | 음성/영상 STT |

선택 키가 없으면 **자동으로 건너뛰고** 나머지 엔진으로 계속 돕니다. 키 없다고 멈추지 않습니다.

## 파일 수용 범용성

| 계열 | 확장자 | 처리 |
|---|---|---|
| 문서 | pdf | 텍스트 레이어 우선 → 없는 페이지만 300DPI 렌더 후 OCR |
| | docx · doc · odt | mammoth → 실패 시 OOXML 직접 파싱 |
| | pptx · ppt · odp | 슬라이드 + **발표자 노트**까지 |
| | xlsx · xls · csv · tsv | 시트를 표 텍스트로 (열 이름 유지) |
| | hwp · hwpx | HWPX는 ZIP+XML 직접 파싱, HWP는 hwp.js / hwp5txt |
| 이미지 | png jpg webp gif bmp tiff heic avif | 전처리 + 다중 엔진 앙상블 OCR, EXIF 촬영일 추출 |
| 미디어 | mp3 m4a wav … | Whisper STT |
| | mp4 mov mkv … | 오디오 STT **+ 장면 전환 프레임 OCR** (발표 슬라이드·화면 녹화) |
| 웹/메일 | html htm xml eml | 본문 추출 + 링크 보존, 메일 헤더 파싱 |
| 코드/노트북 | ts py java … ipynb | 그대로 + 노트북은 마크다운/코드/출력 분해 |
| 압축 | zip | 내부 파일을 각각 재귀 처리 (최대 40개, 깊이 2) |
| 그 외 | 확장자 불명 | 바이트를 보고 텍스트면 텍스트로, 아니면 안내 메시지 |

- 확장자와 실제 내용이 다르면 **매직 넘버를 신뢰**합니다 (`.txt`로 저장된 PNG 등).
- ZIP 컨테이너는 내부 구조를 보고 docx/pptx/xlsx/hwpx를 구분합니다.
- EUC-KR/CP949로 저장된 한글 텍스트를 자동 감지해 디코딩합니다.

선택 의존성(sharp, pdfjs-dist, mammoth, xlsx, jszip, tesseract.js)이 없어도 **크래시 없이** 동작하고,
무엇이 없어서 무엇을 못 읽었는지 `warnings`로 알려줍니다.

## OCR — 가장 정확하게 읽기 위한 설계

한국어는 획이 많아 저해상도·저대비에서 특히 잘 깨집니다. 그래서 4단으로 짰습니다.

**1단계 — 전처리** (`src/ocr/preprocess.ts`)
EXIF 자동 회전 → 회색조 → 대비 정규화 → **2000px 이상으로 업스케일(300DPI 상당)** → 미디언 디노이즈 → 언샤프.
Vision 모델용(비이진화)과 고전 OCR용(이진화) 두 벌을 만듭니다. 엔진마다 잘 먹는 입력이 다르기 때문입니다.

**2단계 — 다중 엔진 병렬 실행** (`src/ocr/providers.ts`)

| 엔진 | 역할 |
|---|---|
| Claude Vision | **주 엔진.** 다단 레이아웃·표·손글씨·도장까지 읽고 읽기 순서를 지킴 |
| Google Vision | 보조. 인쇄체 정밀도 |
| NAVER CLOVA | 보조. 한국어 증명서·영수증 특화 |
| tesseract.js | 오프라인 폴백. 키·네트워크 없이 동작 |

주 엔진 프롬프트는 **원문 그대로 복사**를 강제하고, 확신 없는 글자는 `«불명»`으로 표시하게 합니다.
맞춤법 교정·의역·요약을 금지해 "그럴듯하게 지어낸 글자"를 원천 차단합니다.

**3단계 — 합의 검증 + 재판독** (`src/ocr/index.ts`)
엔진 결과를 문자 바이그램 Dice 계수로 비교합니다. 일치율이 82% 미만이거나 세로 2200px를 넘으면
**겹침 160px를 둔 타일로 잘라 다시 읽고** 합칩니다. 긴 스크린샷에서 작은 글씨가 살아나는 지점입니다.

**4단계 — 신뢰도 산출**
`합의율 + 엔진 자체 점수 − «불명» 비율`로 0~1 점수를 냅니다. 이 점수는 그냥 로그가 아니라
② 배분 단계에 "이 문서는 품질 낮음 — 여기서만 나온 값은 신뢰도를 낮춰라"로 전달되고,
낮은 신뢰도 값은 자동으로 비워집니다.

## 3단 에이전트

### ① 분류 (`src/agents/classifier.ts`)
반드시 **대분류를 먼저** 고르고 그 안에서 세부 유형을 고릅니다. 경계 사례는 규칙으로 못 박았습니다.

- 회사에서 급여 받고 한 일 → `career.work` (팀 프로젝트처럼 보여도)
- 수업의 일부인 팀 과제 → `academic.major_course`의 수업 기록 안
- 상 받은 게 핵심 → `career.award` / 참가가 핵심 → `career.external`
- 작품성이 핵심 → `project.creative` / 배운 점이 핵심 → `growth.*`

한 파일에 여러 경험이 섞여 있으면(포트폴리오·이력서) `multipleExperiences=true`와 분할 제안을 냅니다.

### ② 배분 (`src/agents/extractor.ts`)
유형의 전체 항목 구조에서 **JSON Schema를 동적 생성**하고 `strict: true` 강제 tool 호출로 받습니다.
모든 필드가 nullable이라 **모델이 지어내는 대신 null을 낼 수 있습니다.**

값마다 `evidence`(원문에서 그대로 복사한 문장 + sourceId + 신뢰도)를 함께 받고,
신뢰도 0.4 미만인 값은 파이프라인이 **자동으로 비웁니다.**

### ③ 감독 sub-Agent (`src/agents/supervisor.ts`)
심사자 역할입니다. 원문·정리 결과·근거·기계 검증 결과를 모두 받아 9개 항목을 순서대로 검수합니다.

유형 오판 → **환각** → 주어 왜곡("팀이 한 일"을 "내 역할"에) → 오배치 → 요약 왜곡("참여"→"주도") →
중복 → 분해 누락 → 과소 추출 → 형식.

판정은 `approve` / `revise` / `reclassify`. 수정은 `{path, valueJson}` 패치로 내려오고,
패치로 못 고치는 blocker가 남으면 **②로 되돌려 재작업**시킵니다(최대 2회).
`reclassify`면 유형을 바꿔 처음부터 다시 배분합니다.

**감독 앞단에 결정론적 검증기를 둡니다** (`src/validate/`). LLM이 볼 필요 없는 건 기계가 잡습니다.

- `structural.ts` — 필수 누락, 보기 위반, 날짜 형식/역전, 배열 형식, 한 줄 항목의 줄바꿈
- `grounding.ts` — **환각 탐지.** ⑴ 근거 문장이 원문에 실제로 있는지 ⑵ 값 안의 숫자·영문 고유명사가
  원문에 있는지 ⑶ 파일 항목이 실제 업로드 파일명인지 ⑷ 근거 없이 채워진 긴 값

기계가 먼저 잡아주면 감독은 '의미'에만 집중할 수 있어 정확도가 오르고 비용도 내려갑니다.

### ④ Fallback 안내 (`src/agents/guide.ts`)
**못 채운 칸은 비웁니다.** 대신 비운 칸마다 이렇게 안내합니다.

```json
{
  "label": "결과/성과 > 수치",
  "why": "보고서에 참여자 수나 성과 지표가 적혀 있지 않습니다",
  "whatToProvide": "이 캠페인으로 팔로워가 몇 명 늘었는지, 또는 참여자가 몇 명이었는지 숫자로 알려주세요. 주최 측 결과 리포트 파일이 있으면 올려주셔도 됩니다.",
  "question": "이 활동으로 어떤 수치가 달라졌나요?",
  "priority": "high"
}
```

하나의 답으로 여러 칸이 동시에 채워지는 질문을 골라 `nextQuestions` 3~5개로 추립니다.
분류 신뢰도가 0.55 미만이면 유형 확인 질문(`confirmTypeWith`)도 함께 냅니다.

## 지원하는 경험 유형 (18종)

| 대분류 | 유형 |
|---|---|
| 🎓 학업 | 전공 및 수강 수업 · 학회 · 동아리/교내 단체 · 연구 경험/논문 |
| 💼 커리어 | 인턴 및 업무 경력 · 대외활동 · 수상 경력 · 보유 자격증 · 어학 능력 |
| 🚀 프로젝트 | 개인 프로젝트 · 팀 프로젝트 · 창작물/작업물 |
| 🌱 개인성장 | 봉사활동 · 해외 경험 · 운동 및 신체 역량 · 독서 · 기록(일지/회고) · 목표/계획 |

각 유형은 공통 항목(기본 정보 6 + 확장 입력 8)을 포함하고 전용 항목이 더해집니다.
전용 항목과 의미가 겹치는 공통 항목은 `supersedes`로 선언되어 **화면에서 자동으로 숨겨집니다**
(값은 저장됨 — 실제 `ExperienceFormV2.formLayout` 동작과 동일).

## ARC 본체에 붙이기

이 저장소는 ARC 본체와 독립적으로 돌도록 짜여 있습니다. 붙일 때 건드릴 곳은 두 군데입니다.

1. **스키마** — `src/schema/templates-v2.ts`가 문서 기준으로 새로 정의한 것입니다.
   본체에 이미 `lib/constants/templates-v2.ts`가 있다면, 그쪽 상수를 읽어
   `ExperienceTypeSpec[]`로 변환하는 어댑터만 끼우면 나머지 전부 그대로 돕니다.
2. **결과 바인딩** — `result.form.values`가 폼 상태, `result.form.layout`이 렌더 순서입니다.
   `hiddenCommonKeys`는 중복 제거로 숨길 공통 항목입니다.

```ts
// 예: Next.js Route Handler
export async function POST(req: Request) {
  const form = await req.formData();
  const files = await Promise.all(
    form.getAll("files").map(async (f) => {
      const file = f as File;
      return { name: file.name, mimeType: file.type, bytes: new Uint8Array(await file.arrayBuffer()) };
    }),
  );
  const result = await organizeExperience(files, { userHint: String(form.get("hint") ?? "") });
  return Response.json(result);
}
```

## 튜닝 포인트 (`src/config.ts`)

| 값 | 기본 | 의미 |
|---|---|---|
| `maxSupervisorRounds` | 2 | 감독 재검수 최대 횟수 |
| `classificationConfidenceFloor` | 0.55 | 미만이면 사용자에게 유형 확인 요청 |
| `fieldConfidenceFloor` | 0.4 | 미만인 값은 자동으로 비움 |
| `ocrAgreementFloor` | 0.82 | 엔진 간 일치율이 미만이면 타일 재판독 |
| `EFFORT.supervisor` | `xhigh` | 감독만 높게 — 정확도가 여기서 갈림 |

## 선택 설치로 얻는 것

```bash
npm i sharp pdfjs-dist mammoth xlsx jszip tesseract.js   # Node 패키지
apt install poppler-utils ffmpeg                          # 스캔 PDF 렌더 / 영상 처리
```

없으면 그 부분만 건너뛰고 `warnings`에 이유가 남습니다.
