import type { ExtractedDoc } from "../types.js";
import type { LlmSession } from "../llm/index.js";
import { buildEvidenceBundle } from "./evidence.js";

/**
 * 사실 시트 — 값싼 모델 1회로 만들고 이후 모든 단계가 재사용한다.
 *
 * 이게 있으면 뒤 단계에 원문 전체를 반복해서 밀어 넣을 필요가 줄고,
 * 무엇보다 **수치와 고유명사의 누락**이 크게 준다. 오타·구어도 여기서 한 번 걸러진다.
 */
export interface Factsheet {
  docType: string;
  register: string;
  title: string | null;
  outline: { heading: string; summary: string }[];
  entities: { people: string[]; orgs: string[]; products: string[]; tools: string[] };
  numbers: { value: string; unit: string | null; context: string; before: string | null; after: string | null }[];
  dates: { value: string; context: string }[];
  myActions: string[];
  teamActions: string[];
  unclear: string[];
  achievements: string[];
  problems: string[];
  learnings: string[];
  links: string[];
  normalized: { as_written: string; meaning: string }[];
}

const SYSTEM = `당신은 문서에서 **사실만** 뽑아내는 정리자다.
해석·요약·평가를 하지 말고, 나중에 누가 읽어도 원문을 재구성할 수 있는 '사실 시트'를 만든다.

── 반드시 지킬 것 ──
1. **문서 전체를 끝까지 읽는다.** 앞부분만 보고 판단하지 않는다.
2. 오타·비문·구어체가 있어도 **맥락으로 의미를 복원**한다.
   '개꿀', '빡셈', '삽질', '갈아넣었다' 같은 말도 무슨 뜻인지 파악해 meaning에 적는다.
   원문 표기는 as_written에 그대로 남긴다. 임의로 고쳐 쓰지 않는다.
3. **숫자는 하나도 빠뜨리지 않는다.** 각 숫자가 무엇을 가리키는지 context에 적는다.
   비교·증감이 있으면 before/after를 나눠 적는다 (예: 820ms → 210ms).
4. 사람·조직·제품·도구 이름을 원문 표기 그대로 모은다.
5. '내가 한 일'과 '팀/회사가 한 일'을 구분해 적는다. 원문이 모호하면 unclear에 넣는다.
6. 문서 성격(docType)을 판정한다: 공식문서 / 보고서 / 메모 / 일기 / 대화기록 / 이력서 / 기타.
7. 원문에 없는 내용을 만들지 않는다.`;

const SCHEMA = {
  type: "object",
  properties: {
    docType: { type: "string", description: "문서 성격 (공식문서/보고서/메모/일기/대화기록/이력서/기타)" },
    register: { type: "string", description: "문체 (격식체/평서체/구어체/혼합)" },
    title: { type: ["string", "null"], description: "문서가 다루는 활동의 이름" },
    outline: {
      type: "array", description: "섹션별 한 줄 요약. 순서대로.",
      items: {
        type: "object",
        properties: { heading: { type: "string" }, summary: { type: "string" } },
        required: ["heading", "summary"], additionalProperties: false,
      },
    },
    entities: {
      type: "object",
      properties: {
        people: { type: "array", items: { type: "string" } },
        orgs: { type: "array", items: { type: "string" } },
        products: { type: "array", items: { type: "string" } },
        tools: { type: "array", items: { type: "string" } },
      },
      required: ["people", "orgs", "products", "tools"], additionalProperties: false,
    },
    numbers: {
      type: "array", description: "문서의 모든 수치. 빠뜨리지 말 것.",
      items: {
        type: "object",
        properties: {
          value: { type: "string" },
          unit: { type: ["string", "null"] },
          context: { type: "string", description: "이 숫자가 무엇을 가리키는지" },
          before: { type: ["string", "null"] },
          after: { type: ["string", "null"] },
        },
        required: ["value", "unit", "context", "before", "after"], additionalProperties: false,
      },
    },
    dates: {
      type: "array",
      items: {
        type: "object",
        properties: { value: { type: "string" }, context: { type: "string" } },
        required: ["value", "context"], additionalProperties: false,
      },
    },
    myActions: { type: "array", description: "'내가' 한 일. 원문 표현을 살릴 것.", items: { type: "string" } },
    teamActions: { type: "array", description: "팀/회사/타인이 한 일", items: { type: "string" } },
    unclear: { type: "array", description: "주어가 모호해 판단이 안 되는 것", items: { type: "string" } },
    achievements: { type: "array", description: "성과·결과. 수치가 있으면 함께.", items: { type: "string" } },
    problems: { type: "array", description: "문제·한계·어려움과 그 대응", items: { type: "string" } },
    learnings: { type: "array", description: "배운 점·회고", items: { type: "string" } },
    links: { type: "array", items: { type: "string" } },
    normalized: {
      type: "array", description: "오타·구어·줄임말을 표준 표현으로 옮긴 기록",
      items: {
        type: "object",
        properties: { as_written: { type: "string" }, meaning: { type: "string" } },
        required: ["as_written", "meaning"], additionalProperties: false,
      },
    },
  },
  required: ["docType", "register", "title", "outline", "entities", "numbers", "dates",
    "myActions", "teamActions", "unclear", "achievements", "problems", "learnings",
    "links", "normalized"],
  additionalProperties: false,
} as const;

export async function buildFactsheet(session: LlmSession, docs: ExtractedDoc[]): Promise<Factsheet> {
  return session.structured<Factsheet>({
    stage: "extract",
    systemStable: SYSTEM,
    toolName: "submit_factsheet",
    toolDescription: "문서에서 뽑은 사실 시트를 제출한다.",
    schema: SCHEMA as unknown as Record<string, unknown>,
    content: [{ type: "text", text: buildEvidenceBundle(docs) }],
    maxTokens: 16000,
    light: true,
  });
}

/** 사실 시트를 프롬프트에 넣을 텍스트로. */
export function factsheetText(fs: Factsheet | null): string {
  if (!fs) return "";
  const L: string[] = [];
  L.push(`문서 성격: ${fs.docType ?? "?"} / 문체: ${fs.register ?? "?"}`);
  if (fs.title) L.push(`활동명 후보: ${fs.title}`);
  if (fs.outline?.length) {
    L.push("구성: " + fs.outline.slice(0, 20).map((o) => `${o.heading}=${o.summary}`).join(" | "));
  }
  const ent = fs.entities ?? ({} as Factsheet["entities"]);
  for (const [k, ko] of [["orgs", "조직"], ["people", "사람"], ["products", "제품"], ["tools", "도구"]] as const) {
    const v = ent[k];
    if (v?.length) L.push(`${ko}: ${v.slice(0, 15).join(", ")}`);
  }
  if (fs.dates?.length) {
    L.push("날짜: " + fs.dates.slice(0, 15).map((d) => `${d.value}(${d.context})`).join(" / "));
  }
  if (fs.numbers?.length) {
    L.push("수치(원문 근거 있음):");
    for (const n of fs.numbers.slice(0, 40)) {
      const ba = n.before || n.after ? ` [${n.before ?? "?"} → ${n.after ?? "?"}]` : "";
      L.push(`  · ${n.value}${n.unit ?? ""} — ${n.context}${ba}`);
    }
  }
  for (const [k, ko] of [["myActions", "내가 한 일"], ["teamActions", "팀이 한 일"],
    ["achievements", "성과"], ["problems", "문제·한계"], ["learnings", "배운 점"],
    ["unclear", "주어 불명"]] as const) {
    const v = fs[k];
    if (v?.length) L.push(`${ko}: ${v.slice(0, 15).join(" / ")}`);
  }
  if (fs.links?.length) L.push("링크: " + fs.links.slice(0, 10).join(", "));
  if (fs.normalized?.length) {
    L.push("표기 정규화: " + fs.normalized.slice(0, 20).map((x) => `${x.as_written}→${x.meaning}`).join(", "));
  }
  return L.join("\n");
}
