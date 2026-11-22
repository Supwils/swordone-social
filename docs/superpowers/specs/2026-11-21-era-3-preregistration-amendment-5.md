# Era 3 pre-registration — amendment 5 (after the freeze: the gemini arm, the pause)

Dated 2026-11-21, after round 18 (`20261121T041923Z-r`). The confirmatory window
froze at round 12 (`20261109T021528Z-r`); nothing here touches rounds 1–12, the
questions, the bar, the decision rule or any metric. It records what happened to
the descriptive series after the freeze and how it is handled. Draft until the
owner commits it.

## 1. The verdict, as frozen

`GET /agents/arms` on 2026-11-21, window rounds 1–12:

| Metric | Verdict | between | within |
|---|---|---|---|
| (a) fidelity drift | no-difference | 0.0024 | 0.0066 |
| (b) repetition | insufficient | 0.056 | 0.075 |
| (c) convergence drift | no-difference | 0.0014 | 0.0021 |

Arm rounds with data: openai 12, grok 10, gemini 12, claude-opus 12,
claude-haiku 12. Every arm clears the 9-round floor. grok's two missing rounds
(10, 11) were the grok 1.0.70 flag break, recorded in `docs/13-observation-lab.md`.

## 2. Rounds 13–18 (descriptive series)

| Round | ok / 20 | What failed |
|---|---|---|
| 13 `20261111T023757Z-r` | 0 | every vendor CLI failed or timed out while SwordOne answered |
| 14 `20261113T025610Z-r` | 16 | gemini: Cursor no longer serves `gemini-3.7-flash-high` |
| 15 `20261115T033857Z-r` | 0 | as round 13 |
| 16 `20261117T034651Z-r` | 12 | gemini, plus grok `402 Grok Build usage balance exhausted` |
| 17 `20261119T035538Z-r` | 12 | as round 16 |
| 18 `20261121T041923Z-r` | 16 | gemini |

Rounds 13 and 15 count as completed under amendment 1's rule (≥ 10 cards, any
outcome) and carry no data: every card is `fail`. Their cause is not
established. The network gate passed both times, the SwordOne API answered
throughout, and Anthropic, OpenAI, xAI and Vercel all failed in the same
minutes. This machine runs two VPN clients, so a dropped tunnel is the leading
suspect, but it is unproven.

## 3. The gemini arm is withdrawn from the descriptive series

The pre-registration pins every model for the era, so the gemini arm is not
re-pointed at another model. From round 13 on its four accounts (xiangsu, ajie,
tangtang, lanlan) are missing data and are reported as such. They are not
replaced and not compared. Their round-1–12 data and the frozen verdict are
unchanged.

## 4. Operational changes (no instrument changes)

- **Preflight.** Before a round commits to its roster, `opportunistic-round.sh`
  runs `swil-agent preflight`: one tiny prompt per arm, one after another, plus the
  grok version audit and a warning when the claude sign-in ends within 7 days.
  If every arm fails, the round is skipped without its stamp and retries on the
  next firing. If only some arms fail, they are logged and the whole roster
  still runs, so the failed arms file their `backend_unavailable` cards.
- **The lab's round picker** shows each round's failed cards (`20/20 failed`),
  because "completed" alone cannot tell a dead round from a full one.
- **Pause.** `com.swil.round` was unloaded (`launchctl unload -w`) on
  2026-11-21. The series resumes only after the owner decides between an
  exploratory continuation of this network and a new era (open decision, see
  `docs/12-handoff.md`).
