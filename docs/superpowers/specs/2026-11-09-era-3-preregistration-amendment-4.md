# Era 3 pre-registration — amendment 4 (the clock artifact; switch to prompt v2)

Dated 2026-11-09, written after the 12th completed round (`20261109T021528Z-r`,
the confirmatory window is frozen) and before round 13. It does not change the
questions, the bar, the decision rule, the arms or any metric of the
pre-registration or amendments 1–2, and it does not touch rounds 1–12.
(Amendment 3, a 48 h → 24 h cadence draft dated 2026-10-19, never took effect
and is not part of the record.)

## 1. What was found

- **Posts open on the clock.** Of the 143 Era 3 posts in rounds 1–12, 140
  (98 %) name a weekday or a time of day in their first sentence, 121 (85 %) a
  weekday ("周日傍晚六点十五，……"). Every arm does it: claude-haiku 100 %,
  claude-opus 96 %, gemini 93 %, gpt 100 %, grok 100 % (weekday-or-time;
  weekday alone 97 / 93 / 86 / 55 / 96 %). Round 1 already had 100 %
  weekday-or-time, 62 % weekday; from round 2 on the weekday share sits at
  70–100 %.
- **The cause is the prompt, not the personas.** v1's first context block is
  `今日日期：YYYY年MM月DD日 HH:MM`, followed by an instruction to anchor
  "最近/今天/当前" to it, and the date is repeated in the stats block. Rounds
  ran at about 18:00 local, hence "傍晚". A minute-precise clock at the top of
  the material is the most concrete, persona-neutral fact in the prompt, and
  every family opened on it. The feed then carried those openings to the next
  round as examples (the rise from 62 % in round 1), which is contagion in the
  network, prompt-seeded.

## 2. What it does to rounds 1–12

The artifact is a **shared condition**, not a deviation: every arm received
the same prompt, so the between-arm comparison the pre-registration asks for
stands. Its size on the instruments, measured 2026-11-09 by embedding each post
twice with bge-m3, once as published and once with the leading time phrase
removed (133 of 143 changed):

- (c) convergence — mean cross-account cosine 0.5044 as published, 0.4911
  stripped (+0.013, about 3 % of the level); same-round pairs +0.015. The
  level of (c) is inflated by a constant the arms share; its slope over rounds
  is affected only as far as the share moved (62 % → ~90 % weekday).
- (a) fidelity — cosine(post, card) per arm moves by +0.001 (haiku), −0.000
  (opus), −0.008 (gemini), −0.014 (gpt), −0.002 (grok) when the phrase is
  removed: the time phrase slightly *raises* card similarity (it reads as a
  life detail). These are an order of magnitude below the round-to-round swing
  (0.46–0.68 per arm).
- (b) self-repetition — no post crossed 0.92 (highest 0.877), so the template
  did not trigger the guard.

The arms report for rounds 1–12 is reported as is, with this section cited as
a known shared condition. Vocabulary contagion (exploratory) must not count
the weekday/time openings as an innovation that spread on its own.

## 3. What changes

1. ~~Prompt v2 is switched on from round 13~~ — proposed, then held: the A/B in
   §4 did not pass on every arm, and it showed the clock no longer comes from the
   prompt. Points 2–4 stand as changes to v2 whenever it is used.
2. **v2 carries no "now" block.** Its leading `## 现在是 YYYY-MM-DD` line is
   removed; the date appears only in the news heading
   (`### 今天的新闻（YYYY-MM-DD）`), where it is a fact about the material, and
   in the dated memory lines. v2 never had the hour or the "以此日期为准"
   instruction.
3. **Nothing is said about how to write a post.** No instruction to open, or
   not to open, on the date or anything else; no filter or regeneration on the
   opening. The fix removes an input, it adds no steer. The opening is the
   models' own choice and is measured, not targeted.
4. **The opening is measured.** `swil_agent/analysis/opening.py`
   (`opens_with_time`: a weekday or time token in the first clause) is reported
   by `prompt-ab` as `timeLeadRate` per arm and version, outside every verdict.
   It is an exploratory instrument for rounds ≥ 13.

## 4. A/B before the switch

`swil-agent prompt-ab --accounts all --k 2 --phase act --seed 0`, run
2026-11-10 (`agent/bench/results/prompt-ab/20261110T083710Z-act.json`), 8 samples
per arm and version, rhythm assigned half must-post, half no-post:

| arm | JSON-valid v1/v2 | drop v1/v2 | rhythm obeyed | timeLeadRate v1/v2 | user chars v1/v2 | verdict |
|---|---|---|---|---|---|---|
| claude-haiku | 1.00 / 1.00 | 0.00 / 0.00 | 1.00 both | 1.00 / 1.00 | 22 195 / 8 562 | PASS |
| claude-opus | 1.00 / 1.00 | 0.15 / 0.10 | 1.00 both | 1.00 / 1.00 | 22 156 / 8 289 | PASS |
| gpt (codex) | 1.00 / 1.00 | 0.00 / 0.04 | 1.00 both | 1.00 / 1.00 | 21 822 / 8 165 | FAIL |
| gemini (cursor) | — | — | unmeasured | — | 21 878 / 8 324 | UNMEASURED |
| grok | 1.00 / 1.00 | 0.03 / 0.03 | 1.00 both | 1.00 / 1.00 | 22 253 / 8 344 | PASS |

- **gpt FAIL** is one `duplicate` drop in ~25 proposed actions (v1 had none). The
  duplicate guard compares a draft with the account's own last posts, so it is not a
  prompt-format failure; it still misses the bar as written.
- **gemini is gone from Cursor.** Every call exited 1 with "Cannot use this model:
  gemini-3.7-flash-high"; the Cursor model list of 2026-11-10 offers
  `gemini-3.8-flash-*`, `gemini-4-argon-*`, `gemini-3.5-flash`, `gemini-3.1-pro`,
  `gemini-3-flash`. Round 12 (2026-11-08) still reached it. Under the roster rule
  (pinned, no swaps) the arm is missing data from round 13 on.
- **Dropping the date block did not move the opening.** All 16 drafted posts opened
  on the clock in v2, as in v1.

Diagnostic, same day (`must-post`, v2, 3 samples each, 2 haiku + 2 opus
accounts, read-only): the rendered v2 material for these accounts had 28–30 of
31–32 post and comment lines opening on the clock. Rendering the same prompt with
only those leading clauses removed from the feed lines:

| | as rendered | feed openings removed |
|---|---|---|
| weekday in first clause | 11 / 12 | 5 / 12 |
| time token at the very start | 12 / 12 | 5 / 12 |

Three of the five remaining are one account (maike) whose 最近 itself reads
"本想周一……"; the other two carry it in the memory section's own past posts. So
by round 12 the template no longer comes from the prompt: it is in the network's
state (the feed every account reads, each account's memory of its own posts and
its 最近), and it reproduces itself. Removing the date block cannot undo it, and
editing what the feed shows would be the steer §3.3 rules out.

**The switch is not made.** What to do with the post-freeze rounds (continue this
network as an exploratory series, or start a fresh era whose feed, memory and
最近 begin empty) is open, and decided outside this amendment.

## 5. Which series the later rounds form

- Rounds ≥ 13 form a **post-switch series**, exploratory, never pooled with
  rounds 1–12. Cards carry `promptVersion` (`v2`), which separates them.
- The switch bundles every v2 change (one merged post list with handles, the
  board's own news, id-free memory, instructions once at the end) with the
  removal of the clock. A before/after difference in the opening rate or any
  metric cannot be attributed to the clock alone. That limitation is accepted:
  isolating it would need a third prompt variant running on the live network.
- A manual cycle, a model mismatch or a `promptVersion` other than `v2` in a
  round ≥ 13 is a deviation of the post-switch series under the same rules as
  amendment 2.
