"""ragkor/seed.py → src/ragkor/seed.ts 기계 변환.

시드는 사람이 쓴 데이터라 손으로 옮기면 오타가 난다.
Python 쪽을 단일 출처로 두고 TS는 여기서 생성한다.
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from ragkor.seed import (ABBREVIATIONS, NEOLOGISMS, SEED_CLUSTERS,  # noqa: E402
                         SPELLING_VARIANTS, TYPO_SEEDS)

OUT = ROOT / "src" / "ragkor" / "seed.ts"


def rec(d: dict, indent: str = "  ") -> str:
    lines = [f'{indent}{json.dumps(k, ensure_ascii=False)}: {json.dumps(v, ensure_ascii=False)},'
             for k, v in d.items()]
    return "\n".join(lines)


clusters = ",\n".join(
    f'  ["{head}", "{members}", "{domain}"]' for head, members, domain in SEED_CLUSTERS)

OUT.write_text(f'''/**
 * RAGKOR 시드 — 규칙 확장의 출발점.
 *
 * ⚠ 이 파일은 `python tools/gen_seed_ts.py` 로 생성됩니다.
 *   직접 고치지 말고 `ragkor/seed.py` 를 고친 뒤 다시 생성하세요.
 *   (Python과 TypeScript 구현이 같은 사전을 쓰도록 단일 출처를 유지합니다.)
 *
 * 선정 기준은 하나다: 경험 기록 문서에서 실제로 같은 뜻으로 갈려 쓰이는 말.
 */

/** [대표형, 멤버(공백 구분), 도메인] */
export const SEED_CLUSTERS: readonly (readonly [string, string, string])[] = [
{clusters},
] as const;

/** 틀린 표기 → 표준 표기 */
export const SPELLING_VARIANTS: Record<string, string> = {{
{rec(SPELLING_VARIANTS)}
}};

/** 신조어·커뮤니티·업무체 → 문서어 */
export const NEOLOGISMS: Record<string, string> = {{
{rec(NEOLOGISMS)}
}};

/** 줄임말 → 정식 명칭 */
export const ABBREVIATIONS: Record<string, string> = {{
{rec(ABBREVIATIONS)}
}};

/** 오타 변형을 생성할 고빈도 도메인 용어 */
export const TYPO_SEEDS: readonly string[] = {json.dumps(TYPO_SEEDS, ensure_ascii=False, indent=2)};
''', encoding="utf-8")

print(f"생성: {OUT} ({OUT.stat().st_size/1024:.0f} KB)")
print(f"  클러스터 {len(SEED_CLUSTERS)} · 표기변이 {len(SPELLING_VARIANTS)} · "
      f"신조어 {len(NEOLOGISMS)} · 줄임말 {len(ABBREVIATIONS)} · 오타시드 {len(TYPO_SEEDS)}")
