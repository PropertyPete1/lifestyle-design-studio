/**
 * eslint.config.mjs — one rule, and it is here because it already paid for itself.
 *
 * `no-undef` only. This is not a style pass and deliberately not a broad lint
 * config: the repo has a strong test suite and a house style that reads
 * consistently, and a hundred formatting complaints would be noise nobody
 * actions.
 *
 * WHAT IT CATCHES that 1261 tests did not: an identifier that does not exist at
 * a call site only production reaches. `buildVisuals` takes ffmpeg as an
 * argument so the visual planner can be tested without encoding anything —
 * which is right — and the pipeline passed it a bare `ffmpeg` that was never
 * imported. Every test injected its own fake, so nothing in the suite touched
 * that line. The live build transcribed 36 takes over eight minutes, reached the
 * visual stage, and died on `ReferenceError: ffmpeg is not defined`.
 *
 * The rule finds it in under a second, and reports nothing else across src/.
 */
export default [
  {
    files: ["src/**/*.js", "scripts/**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        console: "readonly",
        process: "readonly",
        Buffer: "readonly",
        fetch: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        TextEncoder: "readonly",
        TextDecoder: "readonly",
        AbortController: "readonly",
        structuredClone: "readonly",
        FormData: "readonly",
        Blob: "readonly",
        crypto: "readonly",
      },
    },
    rules: { "no-undef": "error" },
  },
];
