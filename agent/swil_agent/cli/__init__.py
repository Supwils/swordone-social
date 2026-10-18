"""`swil-agent`: the Typer app and the ONE list of its commands.

Entry point `swil-agent = "swil_agent.cli:app"` (pyproject.toml). The package
is laid out by responsibility (S3 §6):

  * `app.py`      -- the Typer app, its callback, the `EXIT_*` codes;
  * `compose.py`  -- every collaborator seam (`compose_backend.py` holds the
    backend leaves, `stores.py` the two local databases);
  * `logs.py`     -- the round logs and their per-record routing;
  * `errors.py`   -- the SKIP classification and the policy-gate reporting;
  * `report.py`   -- what a finished round prints;
  * `run.py`      -- `act`, `dream`, `cycle`;
  * `analysis.py` -- the samplers, the backfill and `intervention`;
  * `ops.py`      -- `version`, `doctor`, `register`, `measure-status`;
  * `prompt_ab.py` -- `prompt-ab`, the offline v1/v2 prompt comparison;
  * `bench.py`    -- the `bench` group (`run`, `all`), bound as `bench_app`.

Registration happens here and nowhere else, in the order `--help` lists the
commands (the `bench` group last). `act`, `dream` and `cycle` are re-exported
(docstrings intact) for callers that inspect the command functions; the two
log filenames are re-exported for the golden harness, which reads them off
this package.
"""

from __future__ import annotations

from swil_agent.cli import analysis as _analysis
from swil_agent.cli import ops as _ops
from swil_agent.cli import prompt_ab as _prompt_ab
from swil_agent.cli.app import app
from swil_agent.cli.bench import bench_app
from swil_agent.cli.logs import ACT_LOG_FILENAME, DREAM_LOG_FILENAME
from swil_agent.cli.run import act, cycle, dream

__all__ = ["ACT_LOG_FILENAME", "DREAM_LOG_FILENAME", "act", "app", "cycle", "dream"]

app.command()(act)
app.command()(dream)
app.command()(cycle)
app.command("behavior-snapshot")(_analysis.behavior_snapshot)
app.command("backfill-post-vectors")(_analysis.backfill_post_vectors)
app.command("population-metric")(_analysis.population_metric)
app.command()(_analysis.intervention)
app.command()(_analysis.summary)
app.command()(_ops.version)
app.command()(_ops.doctor)
app.command()(_ops.register)
app.command("measure-status")(_ops.measure_status)
app.command("prompt-ab")(_prompt_ab.prompt_ab)
app.add_typer(bench_app, name="bench")
