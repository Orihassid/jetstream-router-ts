# AI.md — tools, setup and the prompts that did the work

## Tools and models

- **Claude Code** (CLI, terminal). Models: **Claude Fable 5.1** for planning and implementation,
  **Claude Opus 5.5** for most of the walkthroughs and reviews. Plan mode for Phase 0 and the design
  memo; normal mode for implementation.
- For the code: no MCP servers, custom skills or editor extensions. The agent had shell access, the
  Jetstream endpoints, and the repo.
- **Why TypeScript and not Go.** I know Go, but Node and TypeScript are where I am strongest. This
  exercise is about defending a design and changing it live, so I chose the language where I can
  explain every line and write code without hesitating. What that choice costs, and how the design
  accounts for it, is decision D1 and "Where it stops working" in DESIGN.md.

## What shaped the output

Three files did the steering. `CLAUDE.md` is in the repo; the other two are my working notes.

1. **`CLAUDE.md`**, in the repository root. The rules that mattered most, in order of how often they
   bit: "present 2–3 options with tradeoffs and wait for my choice" (every phase opened with a
   decision list, not code); "the router never awaits" and "the event loop is shared by everything"
   (the two sentences the whole design hangs on); "never log raw post text"; "log decisions" and
   "log prompts" (the agent maintained a decision log and a prompt log itself);
   "idiomatic Node, not ported Go" (no channel emulation, a ring-buffer queue and async loops instead).
2. **A phase-by-phase playbook** I wrote before starting: measure the
   stream → decide → skeleton → routes one at a time → tests → Kubernetes → write-ups → interview
   drill. Each phase ended with review, tests, a commit and a prompt-log entry.
3. **A decision log**, 18 entries in a fixed shape (options / chosen / why / what would change
   my mind). It is the agent's memory between phases and the source for DESIGN.md.

## Representative prompts

The ones behind the important decisions, quoted from my prompt log:

**1. Measure before designing (Phase 0).** "Before we design anything, I want real data. Write a
throwaway script ... for 60 seconds and reports: events/sec overall, a breakdown by kind, collection
and operation ... Then, using those numbers, give me the key design decisions, each with 2–3 options,
concrete tradeoffs and your recommendation." Nine decisions came back with options. The probe also
settled the Jetstream v1/v2 question: the agent connected to both hosts and found v2 is a superset.

**2. Challenging the core line (Phase 1).** After the agent wrote "onEvent is synchronous by design",
I asked: *"wdym? its not async service?"* and then *"if it was in go, same mechanism would exist?"*
The answers became decision D1 in DESIGN.md: Go has a blocking send and scheduler isolation, Node
has neither, so a router that never waits is the only correct option.

**3. Layout before code (Phase 1).** "Show me the module layout and the core types/interfaces before
writing implementations. After writing, walk me through the lifecycle of one event and the shutdown
sequence, and point out anything about the event loop or promise handling I should be able to explain
in the interview." The walkthrough produced the list of subtle points (microtask handoff, bounded
drain, fire-and-forget persist, fatal handlers) I rehearsed from.

**4. Routes one at a time, with the decision each one stresses (Phase 2).** "For each, tell me which
design decision it stresses and whether it changed any assumption in docs/decisions.md" (my decision log). Three
assumptions changed: resume replays whole gaps at full speed; key memory at the cap was far more than
"a few MB" (later measured at 40 MB); follows are so spread out that the burst default had to be calibrated live.

**5. The isolation proof (Phase 3).** "A test where one route's handler never resolves, proving (a)
other routes keep processing, (b) the router keeps accepting events, (c) the stuck route's drop
counter grows." The test counts exactly 94 drops out of 100 and asserts shutdown returns in bounded
time despite a promise that never resolves.

**6. Run every README command (Phase 4).** "Actually run every command in the README from scratch and
fix anything that fails." The first deploy failed: `runAsNonRoot` cannot verify a named `USER node`.
Fixed with a numeric UID. The cluster was deleted and recreated twice to prove the clean path.

## Where the agent helped

- **Measuring before designing.** It wrote the probe that sampled the stream, and later a 36-hour
  baseline. The baseline corrected the first probe, which had been one minute long and misleading.
- **Testing the failure cases on the live stream** instead of arguing about them: a slow handler, a
  CPU-heavy handler, a frozen process, old bookmarks. Two of my numbers turned out to be wrong and
  were fixed because of this.
- **Explaining its own code.** I had it trace one real event through every file, line by line,
  until I could do the trace myself.
- Probing both Jetstream hosts to settle the v1 versus v2 question with facts.
- Catching its own measurement error: `monitorEventLoopDelay` reports interval plus lag, so idle
  read 20 ms; it subtracted the baseline.
- The bounded-timestamp window (keep at most `threshold` timestamps per key): exact and bounded.
- Keeping the decision log and the prompt log current without being asked each time.

## Where I overrode it or pushed back

- **I did not accept "the router is synchronous by design" until I understood it.** I asked what
  that means in an async service and whether Go would behave the same. The answers became decision D1.
- **Server-side filtering.** I had it turn the filter on, looked at what it cost (the deletions
  route went from "any type" to five types), and had it turned off again.
- **The design document.** The first drafts were dense and full of calculations. I had it rewritten
  as a story in plain words: the problem, the options, why I chose one, what it costs.
- **The queue sizes.** The draft said "my answer is about 45 seconds". I asked who decided that.
  Nobody had: the sizes were round numbers checked against the traffic afterwards. The document now
  says so.
- **Options that were not chosen.** I asked for sharding to be written up as an option I considered
  and rejected, with the reason and the point at which I would add it.
- **Unverified claims.** I asked for every `[verify]` marker in the draft to be tested or removed.
- Event time instead of a wall clock for the rolling windows. My own rules file said "injectable
  clock". The agent argued event time is more correct for replay and simpler to test, and I accepted
  the change.

