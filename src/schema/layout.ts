import type { ExperienceTypeSpec, FieldSpec, LayoutSection } from "../types.js";
import {
  BASE_FIELDS,
  EXTENDED_FIELDS,
  EVIDENCE_KEYS,
  HEADER_KEYS,
} from "./common.js";

/** 전용 항목이 대체(supersede)하는 공통 항목 key 집합 */
export function supersededCommonKeys(type: ExperienceTypeSpec): Set<string> {
  const out = new Set<string>();
  const walk = (fields: readonly FieldSpec[]) => {
    for (const f of fields) {
      f.supersedes?.forEach((k) => out.add(k));
      if (f.fields) walk(f.fields);
    }
  };
  walk(type.fields);
  return out;
}

/**
 * ExperienceFormV2.formLayout 재현.
 * 공통 항목을 화면 위치로 재배치하고, 전용 항목과 겹치는 것은 숨긴다.
 */
export function resolveLayout(type: ExperienceTypeSpec): {
  layout: LayoutSection[];
  hiddenCommonKeys: string[];
} {
  const hidden = supersededCommonKeys(type);

  const header = BASE_FIELDS.filter(
    (f) => (HEADER_KEYS as readonly string[]).includes(f.key) && !hidden.has(f.key),
  );

  // 전용 항목을 group 단위 섹션으로 묶는다 (선언 순서 유지)
  const groups: { title: string; fields: FieldSpec[] }[] = [];
  for (const f of type.fields) {
    const title = f.group ?? type.label;
    let g = groups.find((x) => x.title === title);
    if (!g) {
      g = { title, fields: [] };
      groups.push(g);
    }
    g.fields.push(f as FieldSpec);
  }

  // 확장 입력 = 확장 8종 + 접힌 기본 정보(기간/역할/성과) − 전용과 겹치는 것
  const foldedBase = BASE_FIELDS.filter(
    (f) =>
      !(HEADER_KEYS as readonly string[]).includes(f.key) &&
      !(EVIDENCE_KEYS as readonly string[]).includes(f.key) &&
      !hidden.has(f.key),
  );
  const extended = [
    ...foldedBase,
    ...EXTENDED_FIELDS.filter((f) => !hidden.has(f.key)),
  ] as FieldSpec[];

  const evidence = BASE_FIELDS.filter(
    (f) => (EVIDENCE_KEYS as readonly string[]).includes(f.key) && !hidden.has(f.key),
  ) as FieldSpec[];

  const layout: LayoutSection[] = [
    { zone: "header", title: "제목/요약", fields: header as FieldSpec[] },
    ...groups.map<LayoutSection>((g) => ({
      zone: "specialized",
      title: g.title,
      fields: g.fields,
    })),
    { zone: "extended", title: "확장 입력 (선택)", collapsedByDefault: true, fields: extended },
  ];
  if (evidence.length) {
    layout.push({ zone: "evidence", title: "증빙 자료", fields: evidence });
  }

  return { layout, hiddenCommonKeys: [...hidden] };
}

/** 유형에 대해 실제로 값이 저장되는 전체 필드 목록 (공통 + 전용, 중복 제거 후) */
export function allFieldsFor(type: ExperienceTypeSpec): FieldSpec[] {
  const hidden = supersededCommonKeys(type);
  const commons = [...BASE_FIELDS, ...EXTENDED_FIELDS].filter((f) => !hidden.has(f.key));
  return [...(commons as FieldSpec[]), ...(type.fields as FieldSpec[])];
}

/** 라벨 조회용 경로 맵. 'courses[0].courseName' → '수업 기록 > 수업명' */
export function labelForPath(type: ExperienceTypeSpec, path: string): string {
  const parts = path.split(".");
  let fields: readonly FieldSpec[] = allFieldsFor(type);
  const labels: string[] = [];
  for (const raw of parts) {
    const key = raw.replace(/\[\d+\]$/, "");
    const f: FieldSpec | undefined = fields.find((x) => x.key === key);
    if (!f) return path;
    labels.push(f.label);
    fields = f.fields ?? [];
  }
  return labels.join(" > ");
}
