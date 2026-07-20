import difflib

# difflib.Differ tags each line with a 2-char code. Using Differ (not unified_diff)
# avoids any "---"/"+++" header ambiguity with markdown horizontal rules, and for
# short issue bodies showing full context is clearer than hunks.
_CODES = {"  ": "context", "+ ": "add", "- ": "del"}


def build_diff(base: str, proposed: str) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    for line in difflib.Differ().compare(base.splitlines(), proposed.splitlines()):
        op = _CODES.get(line[:2])
        if op is None:  # "? " intraline hint lines
            continue
        out.append({"op": op, "line": line[2:]})
    return out
