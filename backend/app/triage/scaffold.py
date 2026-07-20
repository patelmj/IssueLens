import re

from app.llm.readiness import RUBRICS

# One markdown block per rubric requirement id (ids match RUBRICS in readiness.py).
# Each block's first line is an H2 heading; the rest is an empty labelled scaffold
# with guiding HTML comments. The AI never fills real content here.
SCAFFOLDS: dict[str, str] = {
    "problem_statement": "## Problem Statement\n<!-- What is happening, and why is it a problem? -->\n",
    "expected_behavior": "## Expected Behavior\n<!-- What should happen instead? -->\n",
    "actual_behavior": "## Actual Behavior\n<!-- What actually happens? -->\n",
    "repro_steps": "## Reproduction Steps\n<!-- Minimal steps to reproduce -->\n1. \n2. \n3. \n",
    "environment": "## Environment\n- OS / version: \n- App / dependency version: \n",
    "logs": "## Logs / Error Output\n<!-- Paste logs, stack traces, or screenshots -->\n```\n\n```\n",
    "severity": "## Severity / Impact\n<!-- Who is affected and how badly? -->\n",
    "ownership": "## Ownership / Area\n<!-- Which team, component, or code area owns this? -->\n",
    "user_problem": "## User / Business Problem\n<!-- Who needs this and why? -->\n",
    "desired_outcome": "## Desired Outcome\n<!-- What should be true once this ships? -->\n",
    "acceptance_criteria": "## Acceptance Criteria\n- [ ] \n- [ ] \n",
    "scope_boundaries": "## Scope\n**In scope:**\n- \n\n**Out of scope:**\n- \n",
    "technical_constraints": "## Technical Constraints\n<!-- APIs, performance limits, compatibility -->\n",
    "dependencies": "## Dependencies\n<!-- Blocking issues, PRs, or external decisions -->\n- \n",
    "estimate": "## Estimate\n<!-- Rough size (e.g. S/M/L or days) -->\n",
    "current_implementation": "## Current Implementation\n<!-- How does it work today? -->\n",
    "why_problem": "## Why It Is a Problem\n<!-- What pain does the current state cause? -->\n",
    "affected_systems": "## Affected Systems\n<!-- Which modules, services, or files are involved? -->\n",
    "proposed_direction": "## Proposed Direction\n<!-- Suggested approach, not necessarily final -->\n",
    "risk": "## Risk of Changing It\n<!-- What could break, and how do we de-risk? -->\n",
    "definition_of_done": "## Definition of Done\n- [ ] \n- [ ] \n",
    "what_wrong": "## What Is Wrong or Missing\n<!-- The documentation gap or error -->\n",
    "where": "## Where It Lives\n<!-- Page, section, file, or URL -->\n",
    "audience": "## Who It Affects\n<!-- Which readers, and why it matters -->\n",
    "proposed_correction": "## Proposed Correction\n<!-- Suggested fix or direction -->\n",
    "context": "## Context / Goal\n<!-- What are you trying to do? -->\n",
    "question_stated": "## Question\n<!-- State the specific question -->\n",
    "already_tried": "## What I Have Tried\n<!-- Approaches attempted and their results -->\n",
}

# Coupling guard: a new rubric requirement cannot ship without a scaffold.
_RUBRIC_IDS = {r.id for reqs in RUBRICS.values() for r in reqs}
assert _RUBRIC_IDS <= set(SCAFFOLDS), (
    f"SCAFFOLDS missing entries for rubric ids: {_RUBRIC_IDS - set(SCAFFOLDS)}"
)


def _heading_of(scaffold: str) -> str:
    """The heading text on the scaffold's first line, e.g. 'Reproduction Steps'."""
    first_line = scaffold.splitlines()[0]
    return first_line.lstrip("#").strip()


def _heading_present(body: str, heading: str) -> bool:
    """True if `body` already contains a markdown heading (any level) for `heading`."""
    pattern = rf"(?im)^#{{1,6}}\s+{re.escape(heading)}\s*$"
    return re.search(pattern, body) is not None


def build_proposed_body(
    current_body: str, missing_requirement_ids: list[str]
) -> tuple[str, list[str]]:
    body = current_body or ""
    applied: list[str] = []
    for req_id in missing_requirement_ids:
        scaffold = SCAFFOLDS.get(req_id)
        if scaffold is None:
            continue
        if _heading_present(body, _heading_of(scaffold)):
            continue
        separator = "" if body == "" else ("\n" if body.endswith("\n") else "\n\n")
        body = f"{body}{separator}{scaffold}"
        applied.append(req_id)
    return body, applied
