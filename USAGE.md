# 사용법

## 1. Google API 키 발급

1. <https://aistudio.google.com/apikey> 접속 → **Create API key**
2. 키 복사 (`AIza...` 로 시작)

이 키 하나로 전부 돕니다.

| 하는 일 | 쓰는 것 |
|---|---|
| 유형 분류 · 항목 배분 · 감독 검수 · 안내 생성 | Gemini |
| 이미지/스캔 문서 OCR | Gemini Vision |
| 음성·영상 받아쓰기 | Gemini 오디오 입력 |
| OCR 보조 (선택) | Cloud Vision — 같은 키, GCP에서 API를 켠 경우만 |

> Cloud Vision을 안 켜도 됩니다. 403이 나면 조용히 건너뛰고 Gemini만으로 돕니다.

## 2. 키 넣기 — 둘 중 하나

**방법 A. `.env` 파일** (권장)

```bash
cp .env.example .env
# .env 를 열어서
GOOGLE_API_KEY=AIza...여기에붙여넣기
```

**방법 B. 코드에 직접**

`src/config.ts` 12번째 줄 근처:

```ts
google: process.env.GOOGLE_API_KEY ?? "AIza...여기에붙여넣기",
```

## 3. 설치하고 확인

```bash
npm install
npm run check          # 키가 유효한지, 어떤 모델이 선택됐는지 확인
```

정상이면 이렇게 나옵니다.

```
엔진    : gemini
모델    : gemini-3-pro
보조모델: gemini-3-flash
상태    : 정상 — 사용 가능한 모델 47개 중 "gemini-3-pro" 선택
```

> **모델은 자동으로 고릅니다.** Gemini 모델 ID는 자주 바뀌고 구버전은 종료되므로
> (2.5 계열은 2026-10-16 종료 예정), 시작할 때 ListModels로 실제 쓸 수 있는 모델을
> 받아 **가장 최신 세대**를 씁니다. 고정하고 싶으면 `.env`에
> `GEMINI_MODEL=gemini-2.5-pro` 처럼 적으세요.

## 4. 써보기 — 세 가지 방법

### ⓐ 브라우저에서 바로 (가장 빠름)

```bash
npm run serve
# → http://localhost:5174
```

파일을 끌어다 놓으면 **유형이 판별되고, 그 유형의 폼이 만들어지고, 값이 채워진 화면**이 나옵니다.
프론트 연동이 실제로 어떻게 되는지 보려면 이걸 먼저 띄워보세요.

### ⓑ 터미널에서

```bash
npm run organize -- ./인턴_최종보고서.pdf
npm run organize -- ./상장.jpg --hint "작년에 받은 상"
npm run organize -- ./포트폴리오.zip --out result.json
npm run organize -- ./회고.md --form            # 프론트 바인딩용 JSON만 출력
npm run organize -- --list-types                # 18종 유형 목록
```

### ⓒ 코드에서

```ts
import { organizeExperience, toFormState, readInputFiles } from "./src/index.js";

const result = await organizeExperience(await readInputFiles(["./보고서.pdf"]));
const form = toFormState(result);   // ← 프론트에 그대로 넘기면 되는 형태
```

---

## 5. 프론트엔드 자동 채움

핵심은 **`toFormState(result)`** 하나입니다. 이게 돌려주는 `FormState`에는
"어떤 폼을 그릴지"와 "각 칸에 무슨 값이 들어가는지"가 **둘 다** 들어 있습니다.
프론트는 ARC 스키마 내부를 전혀 몰라도 됩니다.

```ts
const form = toFormState(result);

form.values        // { companyName: "주식회사 라온테크", tasks: [...], salary: null }
form.sections      // [{ title: "근무 정보", fields: [...] }, ...]  ← 이걸 map 해서 그리면 끝
form.completeness  // 64  (진행바)
form.questions     // ["담당 업무의 성과를 숫자로 알려주실 수 있나요?", ...]
```

### 서버 — Next.js App Router

`app/api/organize/route.ts`

```ts
import { organizeExperience, toFormState } from "arc-auto-organize";

export const runtime = "nodejs";        // 파일 처리를 하므로 edge 아님
export const maxDuration = 120;         // 큰 PDF는 1~2분 걸립니다

export async function POST(req: Request) {
  const fd = await req.formData();
  const files = await Promise.all(
    fd.getAll("file").map(async (f) => {
      const file = f as File;
      return {
        name: file.name,
        mimeType: file.type,
        bytes: new Uint8Array(await file.arrayBuffer()),
      };
    }),
  );

  const result = await organizeExperience(files, {
    userHint: String(fd.get("hint") ?? ""),
  });

  return Response.json(toFormState(result));
}
```

### 클라이언트 — 파일 하나 넣으면 폼이 채워진다

`app/experience/new/page.tsx`

```tsx
"use client";
import { useState } from "react";
import type { FormState } from "arc-auto-organize";

export default function NewExperience() {
  const [form, setForm] = useState<FormState | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState(false);

  async function onFile(file: File) {
    setBusy(true);
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch("/api/organize", { method: "POST", body: fd });
    const data: FormState = await res.json();

    setForm(data);
    setValues(data.values);   // ★ 이 한 줄로 모든 칸이 채워집니다
    setBusy(false);
  }

  if (!form) {
    return (
      <input
        type="file"
        disabled={busy}
        onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
      />
    );
  }

  return (
    <form>
      <h2>{form.categoryLabel} › {form.typeLabel}</h2>
      <progress value={form.completeness} max={100} />

      {form.sections.map((section) => (
        <fieldset key={section.title}>
          <legend>{section.title}</legend>
          {section.fields.map((f) => (
            <label key={f.key}>
              {f.label}
              {f.filled && <span className="badge">자동</span>}

              {f.kind === "longtext" ? (
                <textarea
                  value={(values[f.key] as string) ?? ""}
                  placeholder={f.guide?.question}
                  onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                />
              ) : f.kind === "select" ? (
                <select
                  value={(values[f.key] as string) ?? ""}
                  onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                >
                  <option value="">선택 안 함</option>
                  {f.options?.map((o) => <option key={o}>{o}</option>)}
                </select>
              ) : (
                <input
                  value={(values[f.key] as string) ?? ""}
                  placeholder={f.guide?.question}
                  onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                />
              )}

              {/* 비어 있으면 무엇을 주면 채워지는지 안내 */}
              {!f.filled && f.guide && <small>{f.guide.whatToProvide}</small>}
            </label>
          ))}
        </fieldset>
      ))}

      {/* 더 채우기 위한 질문 */}
      <aside>
        <h3>이것만 알려주시면 더 채워집니다</h3>
        <ol>{form.questions.map((q) => <li key={q}>{q}</li>)}</ol>
      </aside>
    </form>
  );
}
```

`daterange` · `tags` · `checklist` · `repeater`까지 전부 처리한 완성 예제는
`public/index.html` 의 `fieldEl()` 함수를 그대로 참고하세요 (바닐라 JS라 옮기기 쉽습니다).

### FormState 레퍼런스

| 필드 | 타입 | 용도 |
|---|---|---|
| `values` | `object` | **폼 상태 초기값.** `setValues(form.values)` 한 줄이면 끝 |
| `sections[]` | `{title, zone, collapsed, fields[]}` | 섹션 카드 단위 렌더링 |
| `fields[]` | 아래 표 참고 | 섹션 구분 없이 평탄한 목록 |
| `typeId` / `typeLabel` | `string` | 판별된 경험 유형 |
| `typeConfidence` | `0~1` | 낮으면 사용자에게 확인받기 |
| `typeRationale` | `string` | "왜 이 유형인가요?" 툴팁 |
| `confirmType` | `{question, candidates[]}` | 신뢰도가 낮을 때만 채워짐 |
| `completeness` | `0~100` | 진행바 |
| `questions[]` | `string[]` | 사용자에게 물어볼 질문 3~5개 |
| `recommendedUploads[]` | `string[]` | 추가로 올리면 좋은 자료 |
| `review` | `{verdict, faithfulness, attentionFields[]}` | 검수 배지 / "확인해 보세요" 목록 |
| `warnings[]` | `string[]` | 파일 처리 경고 (OCR 품질 낮음 등) |
| `hiddenCommonKeys[]` | `string[]` | 중복 제거로 숨긴 공통 항목 |
| `meta` | `{files[], estimatedCostUsd, elapsedMs}` | 처리 정보 |

**`fields[]`의 각 항목**

| 필드 | 설명 |
|---|---|
| `key` | `values[key]` 로 접근하는 키 |
| `label` | 화면에 보여줄 한국어 라벨 |
| `kind` | `text` `longtext` `date` `daterange` `select` `checklist` `tags` `link` `file` `repeater` |
| `value` | 자동으로 채워진 값 (못 채웠으면 `null`) |
| `filled` | 자동으로 채워졌는지 — "자동" 배지 표시용 |
| `required` | 필수 항목 표시 |
| `options` | `select`/`checklist` 보기 |
| `confidence` | `0~1` 값 신뢰도 (근거 없으면 `null`) |
| `evidence[]` | `{fileName, text}` — "출처 보기" 툴팁 |
| `guide` | `{question, whatToProvide, priority}` — 빈 칸 placeholder·도움말 |
| `itemFields[]` | `repeater`일 때 한 행의 칸 구성 |

### 반복 입력(repeater) 다루기

`values[key]`가 배열입니다. 각 원소가 한 행이고, 행의 칸 구성은 `itemFields`에 있습니다.

```tsx
{f.kind === "repeater" && (values[f.key] as any[] ?? []).map((row, i) => (
  <div key={i} className="row">
    {f.itemFields!.map((sub) => (
      <input
        key={sub.key}
        value={row[sub.key] ?? ""}
        placeholder={sub.label}
        onChange={(e) => {
          const rows = [...(values[f.key] as any[])];
          rows[i] = { ...rows[i], [sub.key]: e.target.value };
          setValues({ ...values, [f.key]: rows });
        }}
      />
    ))}
  </div>
))}
```

---

## 6. 유형을 사용자가 직접 고르게 하려면

`typeConfidence`가 낮을 때(`confirmType`이 채워졌을 때) 후보를 보여주고,
사용자가 고른 유형으로 다시 요청하면 분류 단계를 건너뜁니다.

```ts
const fd = new FormData();
fd.append("file", file);
fd.append("typeId", "career.award");   // 사용자가 고른 유형
```

전체 유형 목록은 `GET /api/types` 또는 `import { EXPERIENCE_TYPES } from "arc-auto-organize"`.

---

## 7. 트러블슈팅

| 증상 | 원인과 해결 |
|---|---|
| `Google API 키가 올바르지 않습니다` | 키 오타이거나 만료. `npm run check` 로 확인 |
| `권한이 없습니다(403)` | GCP에서 **Generative Language API**를 켜주세요 |
| `요청 한도를 초과했습니다(429)` | 무료 등급 분당 한도. 자동으로 4회까지 재시도하며, 계속되면 잠시 후 다시 |
| `안전 필터에 걸려…` | 개인정보(주민번호·연락처 등)가 많은 문서. 해당 부분을 가리고 다시 업로드 |
| 스캔 PDF에서 글자가 안 나옴 | `apt install poppler-utils` (페이지를 300DPI 이미지로 렌더해 OCR합니다) |
| HWP를 못 읽음 | `pip install pyhwp` 또는 한글에서 **PDF로 저장** 후 업로드 (HWPX는 기본 지원) |
| 이미지 OCR이 부정확 | `npm i sharp` (전처리로 인식률이 크게 올라갑니다). 더 밝고 정면에서 찍은 사진이 좋습니다 |
| 영상에서 음성이 안 나옴 | `apt install ffmpeg` |
| 응답이 느림 | 큰 PDF·영상은 1~2분 걸립니다. `onProgress` 콜백으로 진행 상황을 보여주세요 |

### 정확도를 더 올리고 싶다면

```bash
npm i sharp pdfjs-dist mammoth xlsx jszip tesseract.js   # 파일 처리 품질
apt install poppler-utils ffmpeg                          # 스캔 PDF / 영상
```

`src/config.ts`에서:

- `THINKING.supervisor`를 `-1`(자동)로 두면 감독이 깊게 검토합니다. `0`으로 두면 빨라지고 싸집니다.
- `PIPELINE.maxSupervisorRounds`를 늘리면 재작업을 더 하지만 느려집니다.
- `PIPELINE.fieldConfidenceFloor`를 올리면 애매한 값을 더 적극적으로 비웁니다.

## 8. 비용 감각

파일 하나(A4 3~5쪽 분량) 기준으로 대략 `$0.01 ~ $0.05` 입니다.
이미지 OCR이 많거나 감독이 재작업을 돌면 올라갑니다.
실제 사용량은 결과의 `meta.estimatedCostUsd`, 또는 `result.usage`에 단계별로 찍힙니다.
