"""ragkor/ 패키지를 Colab 단일 파일에 그대로 주입한다.

검증한 코드와 Colab에서 도는 코드가 갈라지면 안 되므로,
사람이 옮겨 적지 않고 이 스크립트가 기계적으로 합친다.
"""
import ast
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TARGET = ROOT / "colab" / "arc_colab.py"
START = "# <<<RAGKOR_EMBED_START>>>"
END = "# <<<RAGKOR_EMBED_END>>>"

# 순서가 중요하다 — 뒤 모듈이 앞 모듈을 쓴다
MODULES = ["jamo", "normalize", "seed", "build_lexicon", "match", "ground"]

# 표준 라이브러리는 파일 상단에서 이미 import 했으므로 모듈별 import는 전부 걷어낸다.
KEEP_IMPORT: set = set()


def extract(mod: str) -> str:
    """ast로 import 노드를 정확히 걷어낸다 (괄호로 여러 줄에 걸친 import 포함)."""
    src = (ROOT / "ragkor" / f"{mod}.py").read_text(encoding="utf-8")
    tree = ast.parse(src)
    drop_lines: set = set()
    # 함수 안쪽의 relative import까지 전부 걷어낸다 — 합쳐지면 한 네임스페이스라 불필요하다
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and (node.level or 0) > 0:
            drop_lines.update(range(node.lineno, (node.end_lineno or node.lineno) + 1))
    for node in tree.body:
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            drop_lines.update(range(node.lineno, (node.end_lineno or node.lineno) + 1))
        elif (isinstance(node, ast.If) and isinstance(node.test, ast.Compare)
              and getattr(node.test.left, "id", "") == "__name__"):
            drop_lines.update(range(node.lineno, (node.end_lineno or node.lineno) + 1))

    lines = src.splitlines()
    body = "\n".join(l for i, l in enumerate(lines, 1) if i not in drop_lines).strip()

    # 파일시스템 의존 제거 — Colab에는 lexicon.json이 없다
    body = body.replace('_LEX_PATH = Path(__file__).parent / "lexicon.json"', "")
    body = body.replace('OUT = Path(__file__).parent / "lexicon.json"', "")
    body = re.sub(
        r"    @staticmethod\n    def _load\(\) -> dict:\n(?:        .*\n)+?(?=\n    def |\n\n)",
        "    @staticmethod\n    def _load() -> dict:\n        return build()\n",
        body)
    return f"\n# ─────────────── ragkor/{mod}.py ───────────────\n{body}\n"


def main():
    blob = "".join(extract(m) for m in MODULES)
    text = TARGET.read_text(encoding="utf-8")
    if START not in text:
        raise SystemExit(f"{TARGET}에 {START} 마커가 없습니다.")
    head, rest = text.split(START, 1)
    _, tail = rest.split(END, 1)
    merged = f"{head}{START}\n{blob}\n{END}{tail}"
    TARGET.write_text(merged, encoding="utf-8")
    print(f"RAGKOR 주입 완료: {len(blob):,}자 → {TARGET}")


if __name__ == "__main__":
    main()
