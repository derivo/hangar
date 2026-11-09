# Bay ideas for everyday life

A non-binding collection of ideas, not an agreed roadmap. Hangar is meant for
agentic work in everyday life and is not limited to programming. The examples
describe possible uses, not existing features.

## Inbox Bay

- **Purpose:** Collect emails, feeds and links and sort them by relevance and need for action through triage.
- **Everyday example:** In the morning, go through a newsletter, an event notice and a saved article; highlight what is important and file the rest for later reading.

## Planning Bay

- **Purpose:** Bring together calendar, goals and weekly planning.
- **Everyday example:** On Sunday, plan the coming week and reserve time for sport and a personal learning goal between fixed appointments.

## Comms Bay

- **Purpose:** Bundle messages and prepare suitable draft replies.
- **Everyday example:** For an invitation to a shared dinner, create a draft reply that accepts and asks about the time.

## Errand Bay

- **Purpose:** Prepare and handle everyday tasks such as purchases, appointments and forms.
- **Everyday example:** Organise a dentist appointment: collect suitable slots and prepare the registration form that is needed.

## Knowledge Bay

- **Purpose:** Keep notes, decisions and sources together so they can be found.
- **Everyday example:** For the next trip, collect notes on accommodation, the decision for a place and the related sources.

## Automation Bay

- **Purpose:** Bundle and automate recurring workflows.
- **Everyday example:** Have a weekly overview prepared every Friday from open tasks and upcoming appointments.

## Ideas for the agent bay (from the Omnigent analysis)

Source: comparison with [Omnigent](https://omnigent.ai) (Apache-2.0, alpha according to its README, as of 2026-11-02).
Omnigent is a competitor to the agent bay, not a building block; only ideas are taken over.
Starting point in the code: the shell starts without a sandbox and inherits the full `process.env`
(`bays/agents/src/main/sessions.ts`, `pty.ts`); `quota.ts` only displays limits; the bus only knows
`allow | deny | session | ask` (`packages/bus/src/types.ts`).

Order by dependency, effort roughly estimated:

1. **Clean up the environment** – allowlist of environment variables per session instead of full inheritance.
   ~0.5 days, no ADR. Behaviour change for users with keys in their profile.
2. **macOS sandbox per session** (`sandbox-exec`): write access only to the worktree and temp,
   `~/.ssh` and `~/.aws` masked, optionally network blocked. ~3–5 days, ADR needed
   (threat model, opt-in or default). `sandbox-exec` is deprecated – keep watching.
   Linux (bubblewrap) afterwards ~3 days.
3. **Credential proxy**: the agent holds a placeholder token, a local proxy swaps it for the real
   secret. ~1–2 weeks, ADR needed, requires idea 2.
4. **Bus policy "calls per period"**: limit per subject and target. ~2 days, ADR (addition to
   ADR 0006). No cost limit.
5. **Cost warning** when `usedPercent` exceeds a threshold. ~0.5 days, no ADR. A hard
   cost limit would need the proxy from idea 3 – later.
6. **Live collaboration on shared sessions** (input by remote users): ~1–2 weeks, ADR needed,
   reverses the Phase 16 decision "read-only". Only after the sandbox.

Do not take over: harness switching across many agents, policies in Python, server/mobile/Slack.
Open (`UNBEKANNT`): Omnigent's credential and sandbox configuration details, SECURITY.md, audits.
