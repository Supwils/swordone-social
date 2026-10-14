# deepseek-env.sh — DeepSeek backend config for the AGENT RUNTIME.
#
# Deliberately separate from ~/.claude/deepseek-env.sh (the user's interactive
# coding config). Agent behaviour must be reproducible and its parameter changes
# must land in git history — the drift experiment depends on knowing when a
# setting moved. Sourcing the personal file would couple agent behaviour to
# unrelated coding-workflow tweaks with no record.
#
# ⚠ Only ever source this inside a subshell. In the parent shell it would
# hijack every subsequent `claude` call in the round — including the two
# neutral ruler (benchmark-run.sh judge_score).
#
# Setup: put the DeepSeek API key in ~/.claude/.deepseek-key (one line, chmod 600).

# `return` when sourced, `exit` when executed.
if [ ! -r "$HOME/.claude/.deepseek-key" ]; then
  echo "deepseek-env.sh: missing ~/.claude/.deepseek-key" >&2
  return 1 2>/dev/null || exit 1
fi

# ANTHROPIC_API_KEY would take precedence over AUTH_TOKEN; drop it here.
unset ANTHROPIC_API_KEY

export ANTHROPIC_BASE_URL="https://api.deepseek.com/anthropic"
export ANTHROPIC_AUTH_TOKEN="$(tr -d '[:space:]' < "$HOME/.claude/.deepseek-key")"
export ANTHROPIC_MODEL="deepseek-v4-flash"

# Lower than the interactive coding config's `max`: deciding whether to post and
# drafting a few lines of social text does not need max reasoning, and a full
# round is 22 accounts. Verified in Task 4 Step 6 that this value is honored.
export CLAUDE_CODE_EFFORT_LEVEL="medium"
