# Review: context menu of a session (2026-11-04)

Subject: uncommitted diff "context menu on sessions in the project tree":
`bays/agents/src/ui/Menu.tsx`, `ProjectTree.tsx`, `App.tsx`,
`SessionPane.tsx`, `Workspace.tsx`, `styles.css`,
`apps/desktop/e2e/session-menu.spec.ts`, `e2e/a11y.spec.ts`.
Reviewer: Codex (`codex exec -s read-only`).

## Findings

| No. | Prio | Finding                                                                                                                                              | Decision                                                                                                                                                                                         |
| --- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | P2   | A completed request (such as "Schedule job…") stayed in `App`; when the session showed again, the newly mounted `SessionPane` opened the form again. | Accepted. The pane reports `onRequestDone`, `App` deletes the request. Test `does not repeat a request when the session shows again` (first red, then green).                                    |
| 2   | P2   | Description, environment variables and job did not reach an undocked session; the menu offered them anyway.                                          | Accepted in the small form: for undocked sessions the three entries are locked (`aria-disabled`), the own window has the forms. No channel into the other window. Test in the tree.              |
| 3   | P2   | Tab and Shift+Tab only set the focus back to the session instead of moving on (APG).                                                                 | Accepted. Tab closes, gives the focus to the session synchronously and lets the default navigation continue from there. Test checks the focus target in both directions (first red, then green). |
