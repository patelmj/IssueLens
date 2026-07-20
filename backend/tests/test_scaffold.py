from app.triage.scaffold import SCAFFOLDS, build_proposed_body


def test_scaffolds_cover_every_rubric_requirement():
    from app.llm.readiness import RUBRICS

    ids = {r.id for reqs in RUBRICS.values() for r in reqs}
    assert ids <= set(SCAFFOLDS), f"missing scaffolds for {ids - set(SCAFFOLDS)}"


def test_appends_missing_sections_in_order():
    body, applied = build_proposed_body("A bug happened.", ["repro_steps", "environment"])
    assert applied == ["repro_steps", "environment"]
    assert body.startswith("A bug happened.")
    assert "## Reproduction Steps" in body
    assert "## Environment" in body
    assert body.index("## Reproduction Steps") < body.index("## Environment")


def test_is_deterministic():
    a, _ = build_proposed_body("x", ["repro_steps", "logs"])
    b, _ = build_proposed_body("x", ["repro_steps", "logs"])
    assert a == b


def test_is_idempotent():
    once, _ = build_proposed_body("x", ["repro_steps"])
    twice, applied = build_proposed_body(once, ["repro_steps"])
    assert twice == once
    assert applied == []  # heading already present, nothing appended


def test_skips_heading_already_present_any_level():
    body, applied = build_proposed_body("### Environment\n- macOS\n", ["environment"])
    assert applied == []
    assert body.count("Environment") == 1


def test_empty_body():
    body, applied = build_proposed_body("", ["repro_steps"])
    assert body.startswith("## Reproduction Steps")
    assert applied == ["repro_steps"]
