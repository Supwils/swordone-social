"""Persona Bench: the model-comparison eval lane (S3 §8, §12.18-§12.26).

The same persona is replayed OFFLINE through one model on the frozen task
battery (`agent/bench/battery/tasks.json`) and every output is scored:
`vectorFidelity` against the persona's voice, a deterministic `ruleScore`, and
an optional LLM `judgeScore`. Each scored run is archived under
`agent/bench/results/` and POSTed to `/agents/benchmark/runs`. Nothing here
ever posts to the social feed -- the platform is the field study, this is the
controlled experiment.

A field-for-field port of `benchmark-run.sh` / `benchmark-all.sh` (deleted in
S3), so rows written after the port stay one series with the rows before it:

  * `persona.py` -- persona resolution, the system prompt, the reference text;
  * `rules.py`   -- the two deterministic rule checks and output trimming;
  * `judge.py`   -- the judge call, the exact Bash argv over the `Runner`;
  * `models.py`  -- which backend a `<model>` argument means;
  * `runner.py`  -- one persona x model run, and the sweep.
"""
