"""Structured suggestion sections and server-side body composition.

A section dict: {requirement_id, heading, body_md, origin: "ai"|"scaffold",
model, edited, removed, stale}. proposed_body is always derived here so the
push flow never needs to know about sections.
"""

import re

from app.triage.scaffold import SCAFFOLDS


def _heading_present(body: str, heading: str) -> bool:
    """True if `body` already contains a markdown heading (any level) for `heading`."""
    pattern = rf"(?im)^#{{1,6}}\s+{re.escape(heading)}\s*$"
    return re.search(pattern, body) is not None


def scaffold_section(requirement_id: str) -> dict:
    scaffold = SCAFFOLDS[requirement_id]
    first_line, _, rest = scaffold.partition("\n")
    return {
        "requirement_id": requirement_id,
        "heading": first_line.lstrip("#").strip(),
        "body_md": rest.rstrip("\n"),
        "origin": "scaffold",
        "model": None,
        "edited": False,
        "removed": False,
        "stale": False,
    }


def footnote(sections: list[dict]) -> str | None:
    ai = [s for s in sections if not s["removed"] and s["origin"] == "ai"]
    if not ai:
        return None
    names = [f'"{s["heading"]}"' for s in ai]
    joined = names[0] if len(names) == 1 else ", ".join(names[:-1]) + " and " + names[-1]
    models = ", ".join(sorted({s["model"] for s in ai if s["model"]}))
    return (
        f"---\n*Sections {joined} drafted by {models} from the existing report"
        " — please confirm or correct.*"
    )


def compose_proposed_body(base_body: str, sections: list[dict]) -> str:
    body = base_body or ""
    appended = [
        section
        for section in sections
        if not section["removed"] and not _heading_present(body, section["heading"])
    ]
    for section in appended:
        separator = "" if body == "" else ("\n" if body.endswith("\n") else "\n\n")
        body = f"{body}{separator}## {section['heading']}\n{section['body_md']}\n"
    note = footnote(appended)
    if note is not None:
        separator = "\n" if body.endswith("\n") else "\n\n"
        body = f"{body}{separator}{note}\n"
    return body
