from app.triage.sections import compose_proposed_body, footnote, scaffold_section


def ai_section(rid="repro_steps", heading="Reproduction Steps", body="1. Go to /login",
               model="qwen3:8b", edited=False, removed=False, stale=False):
    return {"requirement_id": rid, "heading": heading, "body_md": body,
            "origin": "ai", "model": model, "edited": edited,
            "removed": removed, "stale": stale}


def test_scaffold_section_splits_heading_from_body():
    s = scaffold_section("repro_steps")
    assert s["requirement_id"] == "repro_steps"
    assert s["heading"] == "Reproduction Steps"
    assert s["origin"] == "scaffold"
    assert s["model"] is None
    assert s["edited"] is False and s["removed"] is False and s["stale"] is False
    assert "## " not in s["body_md"]            # heading lives in the heading field
    assert "<!-- Minimal steps to reproduce -->" in s["body_md"]


def test_compose_appends_sections_with_headings():
    body = compose_proposed_body("original text", [scaffold_section("environment")])
    assert body.startswith("original text")
    assert "\n## Environment\n" in body


def test_compose_skips_removed_sections():
    s = scaffold_section("environment")
    s["removed"] = True
    assert "Environment" not in compose_proposed_body("orig", [s])


def test_footnote_absent_without_ai_sections():
    assert footnote([scaffold_section("environment")]) is None
    assert "please confirm" not in compose_proposed_body("orig", [scaffold_section("environment")])


def test_footnote_names_ai_sections_and_model():
    note = footnote([ai_section(), scaffold_section("environment")])
    assert note.startswith("---\n*Sections")
    assert '"Reproduction Steps"' in note
    assert "qwen3:8b" in note
    assert note.endswith("please confirm or correct.*")


def test_footnote_joins_two_names_with_and():
    two = [ai_section(), ai_section(rid="expected_behavior", heading="Expected Behavior")]
    note = footnote(two)
    assert '"Reproduction Steps" and "Expected Behavior"' in note


def test_footnote_excludes_removed_ai_sections():
    s = ai_section()
    s["removed"] = True
    assert footnote([s]) is None


def test_compose_empty_base_has_no_leading_gap():
    body = compose_proposed_body("", [scaffold_section("environment")])
    assert body.startswith("## Environment")


def test_footnote_exact_string_single_ai_section():
    note = footnote([ai_section()])
    assert note == (
        '---\n*Sections "Reproduction Steps" drafted by qwen3:8b '
        "from the existing report — please confirm or correct.*"
    )


def test_footnote_three_names_join_with_commas_and_and():
    three = [
        ai_section(),
        ai_section(rid="expected_behavior", heading="Expected Behavior"),
        ai_section(rid="actual_behavior", heading="Actual Behavior"),
    ]
    note = footnote(three)
    assert '"Reproduction Steps", "Expected Behavior" and "Actual Behavior"' in note
