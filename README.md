# site-generator-speed

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/geaven137/site-generator-speed/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/geaven137/site-generator-speed/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A faster drop-in for makefun-site 1.0.0: `solve.js` answers exactly as
makefun-site 1.0.0 does on every case, faster. `main.ts` is the harness driver:
it reads `/input/cases.json`, answers each case with `run()`, and writes
`/output/answers.json`.

How it is faster, without changing an answer:

- Markdown renders in one fused pass over the lines (no block tokens), and the
  inline scanner copies plain text in bulk instead of escaping character by
  character.
- Templates compile once per build to closure trees over one flat mutable scope:
  no scope object per loop iteration, no chain walk per lookup, loop state
  reused and restored.
- Cards are built once per source and shared by the page, index, tag and recent
  renders; word counts run in one allocation-free pass.

## Run it

From the unpacked kit directory:

```
node cli/makefun.mjs grade-local --kit . --bot <this repository> --driver docker
```

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
