# Project workflow

- This project is being migrated from Claude to Codex. Work from the existing
  implementation and make focused tweaks. Preserve the current architecture,
  behavior, and design unless the user asks to change them.
- The canonical repository is https://github.com/pvlabels/Router-Department-Tracking.
  Commit and push completed project changes there, using the existing `main`
  branch unless the user requests another workflow. Check the remote state first
  and preserve existing history; do not force-push.
- Read `README.md` and `PRODUCT.md` before changing application behavior. Keep
  the established terminology, data coverage rules, and Geist design system.
- The app lives in `src/index.html` and `src/Code.js`, with no front-end build
  step. Source changes pushed to `main` trigger the existing Apps Script and
  GitHub Pages deployment workflow.
- Keep credentials, signing materials, private customer/job handoffs, and
  local archives out of this public repository. Respect `.gitignore`.
- Validate the behavior affected by a change before committing. Report the
  pushed commit and any checks or deployment issues relevant to the change.
