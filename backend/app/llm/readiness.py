from dataclasses import dataclass


@dataclass(frozen=True)
class Requirement:
    id: str
    label: str
    points: int


RUBRICS: dict[str, list[Requirement]] = {
    "bug": [
        Requirement("problem_statement", "Problem statement", 15),
        Requirement("expected_behavior", "Expected behavior", 15),
        Requirement("actual_behavior", "Actual behavior", 15),
        Requirement("repro_steps", "Reproduction steps", 20),
        Requirement("environment", "Environment or version", 10),
        Requirement("logs", "Logs, screenshots, or error output", 10),
        Requirement("severity", "Severity or impact", 10),
        Requirement("ownership", "Ownership or category", 5),
    ],
    "feature": [
        Requirement("user_problem", "User or business problem", 20),
        Requirement("desired_outcome", "Desired outcome", 15),
        Requirement("acceptance_criteria", "Acceptance criteria", 20),
        Requirement("scope_boundaries", "Scope boundaries", 15),
        Requirement("technical_constraints", "Technical constraints", 10),
        Requirement("dependencies", "Dependencies", 10),
        Requirement("ownership", "Ownership or category", 5),
        Requirement("estimate", "Estimate", 5),
    ],
    "debt": [
        Requirement("current_implementation", "Current implementation", 15),
        Requirement("why_problem", "Why it is a problem", 20),
        Requirement("affected_systems", "Affected systems", 15),
        Requirement("proposed_direction", "Proposed direction", 15),
        Requirement("risk", "Risk of changing it", 10),
        Requirement("definition_of_done", "Definition of done", 15),
        Requirement("dependencies", "Dependencies", 10),
    ],
    "docs": [
        Requirement("what_wrong", "What is wrong or missing", 30),
        Requirement("where", "Where it lives (page, section, file, or URL)", 25),
        Requirement("audience", "Who it affects or why it matters", 20),
        Requirement("proposed_correction", "Proposed correction or direction", 25),
    ],
    "question": [
        Requirement("context", "Context or goal (what they are trying to do)", 30),
        Requirement("question_stated", "Specific question clearly stated", 30),
        Requirement("already_tried", "What they have already tried", 25),
        Requirement("environment", "Environment or version, if relevant", 15),
    ],
}

for _issue_type, _reqs in RUBRICS.items():
    assert sum(r.points for r in _reqs) == 100, f"rubric {_issue_type} does not sum to 100"
