/**
 * RAGKOR — 한국어 어휘 자원 + 자모 유사도 매처.
 *
 * 한국어 문서에서 "모델이 말한 것이 원문에 실제로 있는가"를 판정한다.
 * 신경망을 훈련한 모델이 아니라 규칙 기반 자원이라, 모든 항목이 어느 규칙에서
 * 나왔는지 역추적되고(origin) 틀린 항목은 그 규칙만 고치면 된다.
 *
 * Python 구현(`ragkor/`)과 같은 알고리즘·같은 시드를 쓴다.
 * 시드는 `python tools/gen_seed_ts.py` 로 생성된다.
 */
export * from "./jamo.js";
export * from "./normalize.js";
export * from "./lexicon.js";
export * from "./match.js";
export * from "./ground.js";
export { SEED_CLUSTERS, SPELLING_VARIANTS, NEOLOGISMS, ABBREVIATIONS, TYPO_SEEDS } from "./seed.js";
