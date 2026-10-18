from swil_agent.llm.extract import collapse_doubled_text, extract_json_object, normalize_plan


def test_collapse_exact_even_length_duplication() -> None:
    half = "这是一段足够长的中文文本用来触发折叠逻辑判断" * 2
    assert collapse_doubled_text(half + half) == half


def test_collapse_odd_length_with_single_joining_char() -> None:
    half = "abcdefghijklmnopqrstuvwxyz0123456789ABCD"
    assert collapse_doubled_text(half + "\n" + half) == half


def test_short_text_is_never_collapsed() -> None:
    """The guard is n >= 40, so genuine short repeats survive."""
    assert collapse_doubled_text("abab") == "abab"


def test_collapse_boundary_at_40_chars() -> None:
    """Pin the guard at its actual edge: 39 chars must NOT collapse, 40 must.

    Both fixtures are genuine X<sep>X / X+X duplications that would collapse
    if the length guard did not block them, not merely repeated characters.
    """
    half19 = "abcdefghijklmnopqrs"  # 19 chars
    below = half19 + "Q" + half19  # 39 chars total, under the guard
    assert collapse_doubled_text(below) == below

    half20 = "abcdefghijklmnopqrst"  # 20 chars
    at_edge = half20 + half20  # 40 chars total, exact duplication
    assert collapse_doubled_text(at_edge) == half20


def test_non_duplicated_prose_is_untouched() -> None:
    text = "A" * 30 + "B" * 30
    assert collapse_doubled_text(text) == text


def test_extract_handles_nested_braces() -> None:
    raw = 'noise {"a": {"b": 1}, "c": "}"} trailing'
    assert extract_json_object(raw) == '{"a": {"b": 1}, "c": "}"}'


def test_extract_strips_code_fences() -> None:
    raw = '```json\n{"action": "post"}\n```'
    assert extract_json_object(raw) == '{"action": "post"}'


def test_extract_ignores_braces_inside_strings() -> None:
    raw = '{"text": "a { not an object"}'
    assert extract_json_object(raw) == raw


def test_extract_honours_escaped_quotes() -> None:
    """A brace inside the escaped-quote span is not enough by itself: a
    *matched* `{...}` pair exposed by a deleted escape-handler still nets to
    the same final depth (one spurious open cancelled by one spurious
    close), so extraction still lands on the true final `}` and the test
    passes even with escape-tracking removed — verified empirically while
    proving this test. The span must expose an UNMATCHED brace so a deleted
    escape-handler shifts the depth count permanently, not just briefly."""
    raw = '{"text": "say \\"{not json now"}'
    assert extract_json_object(raw) == raw


def test_extract_returns_none_when_no_object() -> None:
    assert extract_json_object("no json here") is None


def test_extract_stops_at_first_object_despite_trailing_braces() -> None:
    """A greedy `{.*}` regex would run to the LAST `}` in the text; the
    brace-walker must stop as soon as the first object's depth returns to 0."""
    raw = '{"a": 1} then more text {"b": 2}'
    assert extract_json_object(raw) == '{"a": 1}'


def test_normalize_bare_array() -> None:
    plan = normalize_plan('[{"action":"like","postId":"p1"}]')
    assert [a.kind for a in plan.actions] == ["like"]
    assert plan.actions[0].post_id == "p1"


def test_normalize_object_with_plan_key() -> None:
    plan = normalize_plan('{"plan":[{"action":"post","text":"hi"},{"action":"like","postId":"p"}]}')
    assert [a.kind for a in plan.actions] == ["post", "like"]


def test_normalize_single_object() -> None:
    plan = normalize_plan('{"action":"nothing"}')
    assert [a.kind for a in plan.actions] == ["nothing"]


def test_normalize_drops_entries_without_a_string_action() -> None:
    plan = normalize_plan('[{"action":"like","postId":"p"},{"nope":1},{"action":5}]')
    assert [a.kind for a in plan.actions] == ["like"]


def test_normalize_drops_unknown_action_kinds() -> None:
    plan = normalize_plan('[{"action":"teleport"},{"action":"like","postId":"p"}]')
    assert [a.kind for a in plan.actions] == ["like"]


def test_normalize_returns_empty_plan_on_garbage() -> None:
    assert normalize_plan("not json at all").actions == []


def test_normalize_maps_camelcase_wire_fields() -> None:
    plan = normalize_plan('[{"action":"comment","postId":"p","parentId":"c","text":"x"}]')
    a = plan.actions[0]
    assert (a.post_id, a.parent_id, a.text) == ("p", "c", "x")


def test_normalize_maps_image_topic() -> None:
    plan = normalize_plan('[{"action":"post","text":"x","imageTopic":"old mailboxes"}]')
    assert plan.actions[0].image_topic == "old mailboxes"


def test_normalize_maps_username_field() -> None:
    plan = normalize_plan('[{"action":"follow","username":"zenith"}]')
    assert plan.actions[0].username == "zenith"


def test_normalize_recovers_a_plan_wrapped_in_prose() -> None:
    """Real planners rarely emit bare JSON; json.loads fails on the first
    attempt and normalize_plan must fall back to extract_json_object. This
    is the only reason extract_json_object and normalize_plan live together.

    NOTE on shape asymmetry: extract_json_object returns the first top-level
    OBJECT, not an array, so this recovery path only reconstructs the full
    plan when the wrapped array holds exactly one action — the walker finds
    `{` at the first inner object and stops as soon as that object's depth
    returns to 0, before ever reaching the array's own brackets. A
    single-element array recovers correctly (as this test shows) purely
    because "first object" and "whole plan" coincide. A MULTI-action array
    wrapped in prose does NOT recover fully: only the first action survives
    and every action after it is silently dropped, with no error surfaced.
    See test_normalize_prose_recovery_of_multi_action_array_loses_extras
    below, which documents that failure mode explicitly.
    """
    raw = 'Here is my plan:\n```json\n[{"action":"like","postId":"p1"}]\n```\nHope that works.'
    plan = normalize_plan(raw)
    assert [a.kind for a in plan.actions] == ["like"]
    assert plan.actions[0].post_id == "p1"


def test_normalize_prose_recovery_of_multi_action_array_loses_extras() -> None:
    """Documents the asymmetry above: a multi-action array wrapped in prose
    only recovers its FIRST action. This is a real, silent limitation of the
    recovery path, not a hypothetical — recorded here so it is not
    rediscovered as a surprise later."""
    raw = (
        "Here is my plan:\n```json\n"
        '[{"action":"post","text":"hi"},{"action":"like","postId":"p"}]\n'
        "```\nHope that works."
    )
    plan = normalize_plan(raw)
    assert [a.kind for a in plan.actions] == ["post"]


def test_normalize_returns_empty_plan_when_extracted_text_is_malformed() -> None:
    """extract_json_object can hand back a brace-delimited span that is not
    itself valid JSON (e.g. a trailing comma); normalize_plan must not let
    the resulting json.JSONDecodeError escape."""
    raw = 'noise {"action": "like", } more noise'
    assert normalize_plan(raw).actions == []


def test_handle_keys_are_read_only_when_asked() -> None:
    raw = '{"plan":[{"action":"comment","post":"p1","reply":"c2","text":"好"}]}'
    assert normalize_plan(raw).actions[0].post_id is None
    action = normalize_plan(raw, handle_keys=True).actions[0]
    assert (action.post_id, action.parent_id) == ("p1", "c2")


def test_a_raw_post_id_key_wins_over_a_handle_key() -> None:
    raw = '{"plan":[{"action":"like","postId":"' + "a" * 24 + '","post":"p1"}]}'
    assert normalize_plan(raw, handle_keys=True).actions[0].post_id == "a" * 24


def test_v2_strips_one_leading_at_from_a_follow_or_dm_username() -> None:
    raw = (
        '{"plan":[{"action":"follow","username":"@xiaoman"},'
        '{"action":"dm","username":"@@laozhou","text":"在吗"},'
        '{"action":"follow","username":"@"}]}'
    )
    actions = normalize_plan(raw, handle_keys=True).actions
    assert [a.username for a in actions] == ["xiaoman", "@laozhou", None]


def test_v1_keeps_the_username_exactly_as_written() -> None:
    raw = '{"plan":[{"action":"follow","username":"@xiaoman"},{"action":"dm","username":"@b"}]}'
    assert [a.username for a in normalize_plan(raw).actions] == ["@xiaoman", "@b"]
