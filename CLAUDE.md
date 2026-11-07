# settlers

## Working rules for agents (shared across J's repos)

- **Public-safe by default.** Write everything as if this repo will be public tomorrow. No secrets or real personal data in code, config or history (keys go in env vars and GitHub secrets). No security through hidden code: anything that would be unsafe if the repo went public is a bug, so flag it.
- **PRs, never pushes to `main`.** Every change goes through a pull request that J reviews and merges. Never merge on J's behalf.
- **Every PR opens with a risk tier and a 60-second check.** First line: `Risk: low | medium | high`. Then what could break and the exact lines worth reading.
- **High risk = these paths, or anything that publishes or touches auth:** `.github/`, secrets and tokens, auth and host code, `wrangler.toml` or other deploy config, anything that makes something public. High-risk PRs get an independent review (a fresh agent that hasn't seen the work) before J is asked to merge.
- **No generated files in PRs.** Outputs that a workflow rebuilds stay out of PRs, so they can't collide with that workflow.
- **Small PRs.** One purpose each. Split anything J can't check from a phone in about a minute.
- **Check before explaining.** Read the log, run the test, open the file. A guess is labeled as a guess.
- **Include a ready-to-paste Claude Code prompt** in each PR, as the alternative to merging.
