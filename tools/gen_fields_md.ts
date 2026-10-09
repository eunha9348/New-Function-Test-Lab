/**
 * docs/FIELDS.md 생성기 — 스키마에서 직접 뽑아 쓴다.
 *
 * 필드 명세를 사람이 옮겨 적으면 반드시 어긋난다.
 * 스키마가 바뀌면 이 스크립트를 다시 돌려 문서를 갱신하세요.
 *
 *   npx tsx tools/gen_fields_md.ts
 */
import { writeFileSync } from "node:fs";
import {
  BASE_FIELDS, CATEGORIES, EXPERIENCE_TYPES, EXTENDED_FIELDS, supersededCommonKeys,
} from "../src/schema/index.js";
import type { FieldKind, FieldSpec } from "../src/types.js";

const KIND: Record<FieldKind, [string, string]> = {
  text: ["텍스트", "한 줄 입력"],
  longtext: ["서술형", "여러 줄(긴 글) 입력"],
  date: ["날짜", "날짜 1개 선택"],
  daterange: ["기간", "시작일~종료일 (진행 중 표시 가능)"],
  select: ["선택", "드롭다운에서 1개 선택"],
  checklist: ["체크리스트", "보기 중 복수 선택"],
  tags: ["태그", "자유 입력 복수 태그"],
  link: ["링크", "URL"],
  file: ["파일", "파일 업로드"],
  repeater: ["반복 입력", "같은 형식의 항목을 여러 개 추가 (하위 칸으로 구성)"],
};

const COMMON_LABEL = new Map(
  [...BASE_FIELDS, ...EXTENDED_FIELDS].map((f) => [f.key, f.label]),
);
const HEAD = "| 항목 | 키 | 형태 | 필수 | 보기 |\n|---|---|---|:-:|---|";

function row(f: FieldSpec, indent = ""): string {
  let opts = f.options ? [...f.options].join(" / ") : "";
  if (f.freeOptions) opts += opts ? " (자유 입력 허용)" : "자유 입력";
  return `| ${indent}${f.label} | \`${f.key}\` | ${KIND[f.kind][0]} | ${f.required ? "●" : ""} | ${opts} |`;
}

const L: string[] = [];
const w = (s = "") => L.push(s);

const nSpec = EXPERIENCE_TYPES.reduce((a, t) => a + t.fields.length, 0);
const nSub = EXPERIENCE_TYPES.reduce(
  (a, t) => a + t.fields.reduce((b, f) => b + (f.fields?.length ?? 0), 0), 0);
const nRep = EXPERIENCE_TYPES.reduce(
  (a, t) => a + t.fields.filter((f) => f.kind === "repeater").length, 0);
const nCommon = BASE_FIELDS.length + EXTENDED_FIELDS.length;

w("# ARC 경험 입력 항목 명세");
w();
w("대분류 4개 · 경험 유형 18종에서 실제로 입력받는 항목 전부.");
w("`src/schema/templates-v2.ts` 에서 직접 생성했으며, Python 스키마(`colab/arc_colab.py`)와 일치함을 확인했습니다.");
w();
w("| | |");
w("|---|---:|");
w(`| 대분류 | ${CATEGORIES.length} |`);
w(`| 경험 유형 | ${EXPERIENCE_TYPES.length} |`);
w(`| 공통 항목 | ${nCommon} (기본 정보 ${BASE_FIELDS.length} + 확장 입력 ${EXTENDED_FIELDS.length}) |`);
w(`| 전용 항목 | ${nSpec} |`);
w(`| 반복 입력 | ${nRep}개 (하위 칸 ${nSub}) |`);
w(`| **총 필드** | **${nCommon + nSpec + nSub}** |`);
w();
w("---");
w();
w("## 입력 형태 11종");
w();
w("| 형태 | 설명 |");
w("|---|---|");
for (const [k, [ko, desc]] of Object.entries(KIND)) w(`| ${ko} \`${k}\` | ${desc} |`);
w();
w("---");
w();
w("## 모든 유형 공통 항목");
w();
w("> 실제 폼(`ExperienceFormV2`)에 '기본 정보'라는 섹션은 없습니다. 데이터 모델에서만 공통이고,");
w("> 화면에서는 **경험명·한 줄 요약**이 상단 입력란으로, **증빙 자료**가 마지막 전용 섹션 끝으로,");
w("> **기간·내 역할·핵심 성과**가 접힌 '확장 입력'으로 흩어집니다.");
w("> 전용 항목과 의미가 겹치면 **중복 제거되어 화면에서 숨겨집니다.** 값 자체는 저장됩니다.");
w();
w("### 기본 정보 — 데이터 모델 공통값");
w();
w(HEAD);
for (const f of BASE_FIELDS) w(row(f));
w();
w("### 확장 입력 (선택) — 화면에 보이는 유일한 공통 섹션, 기본 접힘");
w();
w(HEAD);
for (const f of EXTENDED_FIELDS) w(row(f));
w();
w("---");
w();
w("## 경험 유형별 전용 항목");
w();

for (const c of CATEGORIES) {
  const types = EXPERIENCE_TYPES.filter((t) => t.category === c.id);
  w(`## ${c.emoji} ${c.label} — ${types.length}종`);
  w();
  for (const t of types) {
    w(`### ${t.emoji} ${t.label}`);
    w();
    w(`\`${t.id}\``);
    w();
    const hides = [...supersededCommonKeys(t)].sort();
    if (hides.length) {
      w("중복 제거로 **숨겨지는 공통 항목**: "
        + hides.map((k) => `~~${COMMON_LABEL.get(k) ?? k}~~`).join(", "));
      w();
    }
    const groups: { name: string; fields: FieldSpec[] }[] = [];
    for (const f of t.fields) {
      const name = f.group ?? t.label;
      let g = groups.find((x) => x.name === name);
      if (!g) groups.push((g = { name, fields: [] }));
      g.fields.push(f as FieldSpec);
    }
    for (const g of groups) {
      w(`**${g.name}**`);
      w();
      w(HEAD);
      for (const f of g.fields) {
        w(row(f));
        for (const s of f.fields ?? []) w(row(s, "&nbsp;&nbsp;↳ "));
      }
      w();
    }
  }
  w("---");
  w();
}

w("## 참고");
w();
w("- 각 항목의 `키`로 폼 상태에 바인딩합니다 — `values[key]`.");
w("- 반복 입력(`repeater`)은 `values[key]`가 배열이고, 각 원소가 `↳` 로 표시된 하위 칸을 가집니다.");
w("  예: `values.tasks[0].metrics`");
w("- `기간(daterange)`은 `{ start, end, ongoing }` 객체입니다.");
w("- '숨겨지는 공통 항목'은 전용 항목이 같은 의미를 덮는 경우입니다. 폼을 그릴 때 둘 다 보여주면");
w("  사용자에게 같은 것을 두 번 묻게 됩니다. `resolveLayout(type)` 이 이미 걸러서 돌려줍니다.");
w();
w("재생성: `npx tsx tools/gen_fields_md.ts`");

writeFileSync("docs/FIELDS.md", L.join("\n") + "\n", "utf-8");
console.log(`docs/FIELDS.md — ${L.length}줄 / ${nCommon + nSpec + nSub}개 필드`);
