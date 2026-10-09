"""ARC 경험 자동 정리 — Colab 실행기.

Colab에서 **저장소의 엔진(TypeScript) 그대로**를 설치하고 돌린다. 별도로 옮겨 적은 판이 아니다.
여기에는 설치·업로드·결과 표시만 있고, 정리 로직은 전부 `src/` 에 있다.

    import run_engine; run_engine.main()

단계
  1. Node.js 22 준비 (Colab 기본 Node가 낮으면 설치)
  2. 저장소 받기 + npm install + Kiwi 형태소 모델 받기 (처음 한 번, 2~3분)
  3. 파일 업로드 → 엔진 실행 → 칸별 감사 결과·원문 하이라이트 보고서를 출력창에 표시
"""
import os
import shutil
import subprocess
import sys
import time

REPO = os.environ.get("ARC_REPO", "https://github.com/eunha9348/New-Function-Test-Lab.git")
BRANCH = os.environ.get("ARC_BRANCH", "claude/arc-service-awareness-z00hjs")
HOME = os.environ.get("ARC_HOME", "/content/arc-engine")
UPLOADS = os.environ.get("ARC_UPLOADS", "/content/arc-uploads")
NODE_VERSION = "22.12.0"


def _say(msg: str) -> None:
    print(msg, flush=True)


def _run(cmd, cwd=None, env=None, quiet=True):
    """명령 실행. 실패하면 마지막 출력과 함께 멈춘다."""
    r = subprocess.run(cmd, cwd=cwd, env=env, shell=isinstance(cmd, str),
                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    if r.returncode != 0:
        tail = "\n".join(r.stdout.strip().splitlines()[-25:])
        raise RuntimeError(f"실패: {cmd if isinstance(cmd, str) else ' '.join(cmd)}\n{tail}")
    if not quiet:
        print(r.stdout)
    return r.stdout


def _node_major() -> int:
    node = shutil.which("node")
    if not node:
        return 0
    try:
        return int(_run([node, "-v"]).strip().lstrip("v").split(".")[0])
    except Exception:
        return 0


def ensure_node() -> None:
    if _node_major() >= 20:
        return
    _say(f"  Node.js {NODE_VERSION} 설치 중…")
    tar = f"node-v{NODE_VERSION}-linux-x64.tar.xz"
    _run(f"curl -sSLf -o /tmp/{tar} https://nodejs.org/dist/v{NODE_VERSION}/{tar}")
    _run(f"tar -xJf /tmp/{tar} -C /usr/local --strip-components=1")
    if _node_major() < 20:
        raise RuntimeError("Node.js 설치에 실패했습니다.")


def setup(force: bool = False) -> None:
    """엔진 설치. 이미 설치돼 있으면 최신 코드만 받아 온다."""
    t0 = time.time()
    _say("① 준비")
    ensure_node()
    if os.path.isdir(os.path.join(HOME, ".git")) and not force:
        _say("  저장소 갱신…")
        _run(["git", "fetch", "-q", "origin", BRANCH], cwd=HOME)
        _run(["git", "checkout", "-q", "-B", BRANCH, f"origin/{BRANCH}"], cwd=HOME)
    else:
        shutil.rmtree(HOME, ignore_errors=True)
        _say("  저장소 받기…")
        _run(["git", "clone", "-q", "--depth", "1", "-b", BRANCH, REPO, HOME])
    _say("  패키지 설치 (처음엔 1~2분)…")
    _run("npm install --no-audit --no-fund --loglevel=error", cwd=HOME)
    if not os.path.exists(os.path.join(HOME, "models", "kiwi", "sj.morph")):
        _say("  Kiwi 형태소 모델 받기 (약 90MB)…")
        _run("bash tools/fetch_kiwi_model.sh", cwd=HOME)
    _say(f"  준비 완료 ({time.time() - t0:.0f}초)\n")


def api_key() -> str:
    """키 찾기 — 환경 변수 → Colab 보안 비밀(🔑) → 직접 입력."""
    key = os.environ.get("GOOGLE_API_KEY", "").strip()
    if not key:
        try:
            from google.colab import userdata  # type: ignore
            key = (userdata.get("GOOGLE_API_KEY") or "").strip()
        except Exception:
            key = ""
    if not key:
        from getpass import getpass
        key = getpass("Google API 키 (AIza…로 시작): ").strip()
    if not key:
        raise RuntimeError("Google API 키가 없습니다. https://aistudio.google.com/apikey 에서 발급하세요.")
    os.environ["GOOGLE_API_KEY"] = key
    return key


def upload() -> list:
    """Colab 업로드 창으로 파일을 받는다. Colab 밖에서는 ARC_FILES(쉼표 구분)를 쓴다."""
    os.makedirs(UPLOADS, exist_ok=True)
    try:
        from google.colab import files  # type: ignore
        got = files.upload()
        paths = []
        for name, data in got.items():
            p = os.path.join(UPLOADS, os.path.basename(name))
            with open(p, "wb") as f:
                f.write(data)
            paths.append(p)
        return paths
    except ImportError:
        return [p for p in os.environ.get("ARC_FILES", "").split(",") if p]


def organize(paths: list, hint: str = "", quality: str = "balanced") -> dict:
    """엔진 실행. 진행 상황을 그대로 보여 주고, 결과 JSON·HTML 경로를 돌려준다."""
    if not paths:
        raise RuntimeError("올린 파일이 없습니다.")
    out_json = os.path.join(UPLOADS, "result.json")
    out_html = os.path.join(UPLOADS, "report.html")
    cmd = ["npx", "tsx", "src/cli.ts", *paths, "--out", out_json, "--html", out_html, "--quality", quality]
    if hint:
        cmd += ["--hint", hint]
    _say("③ 정리 중 — 유형 판별 → 배분 → 감독 → 필드 감사")
    env = dict(os.environ, KIWI_MODEL_DIR=os.path.join(HOME, "models", "kiwi"))
    p = subprocess.Popen(cmd, cwd=HOME, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    for line in p.stdout:  # type: ignore[union-attr]
        if "Quantization is not supported" in line:
            continue
        print(line, end="", flush=True)
    if p.wait() != 0:
        raise RuntimeError("정리에 실패했습니다. 위 메시지를 확인하세요.")
    return {"json": out_json, "html": out_html}


def show(result: dict) -> None:
    """보고서를 출력창에 그린다."""
    try:
        from IPython.display import HTML, display  # type: ignore
        with open(result["html"], encoding="utf-8") as f:
            display(HTML(f.read()))
    except ImportError:
        _say(f"보고서: {result['html']}")


def download(result: dict) -> None:
    try:
        from google.colab import files  # type: ignore
        files.download(result["html"])
        files.download(result["json"])
    except ImportError:
        pass


def main(hint: str = "", quality: str = "balanced") -> dict:
    setup()
    api_key()
    _say("② 정리할 파일을 올리세요 (PDF·이미지·한글·워드·텍스트 등, 여러 개 가능)")
    paths = upload()
    result = organize(paths, hint=hint, quality=quality)
    show(result)
    return result


if __name__ == "__main__":
    main()
