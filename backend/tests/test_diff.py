from app.triage.diff import build_diff


def test_pure_append_is_all_add_and_context():
    ops = build_diff("line one", "line one\nline two")
    assert {"op": "context", "line": "line one"} in ops
    assert {"op": "add", "line": "line two"} in ops
    assert all(o["op"] != "del" for o in ops)


def test_removed_line_is_del():
    ops = build_diff("keep\ndrop", "keep")
    assert {"op": "del", "line": "drop"} in ops


def test_no_change_is_all_context():
    ops = build_diff("a\nb", "a\nb")
    assert ops == [{"op": "context", "line": "a"}, {"op": "context", "line": "b"}]


def test_markdown_hr_line_is_not_mistaken_for_header():
    # A literal "---" line must survive as content, not be swallowed as a diff header.
    ops = build_diff("---", "---\n## New")
    assert {"op": "context", "line": "---"} in ops
    assert {"op": "add", "line": "## New"} in ops
