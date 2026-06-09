// Concise plan-quality principles shared by Planner and Checker.
// Keep this text single-sourced so both surfaces review the same standard.

export const PLAN_QUALITY_PRINCIPLES = [
  "PLAN QUALITY PRINCIPLES:",
  "- Prefer the smallest Tasks that each deliver a complete, independently-verifiable slice of the outcome; sequence so the riskiest end-to-end path is proven by an early verifiable Task before broad build-out; avoid Tasks that only build one layer and can't be checked on their own.",
  "- Plan verification around observable behavior end-to-end (what a user or caller can do and see), not internal wiring; a good check survives an internal rewrite.",
  "- Before adding a new artifact/step/layer, ask whether removing it would concentrate complexity or just move it around; don't add indirection that earns nothing.",
  "- Consider an alternative approach before committing and recommend the stronger one with reasons.",
].join("\n");
