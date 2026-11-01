"""Generate the requirements seed (692 items) from Appendix A of the requirements doc.

Usage (from ``backend/``)::

    uv run python scripts/build_requirements_seed.py

Reads ``requirements/requisitos-exame-graduacao.md`` and writes
``src/seed_data/requirements.json``. The item counts in each belt heading
("24 itens (11 teóricos, 13 práticos)") are checked against the parsed items.
"""

import json
import logging
import re
import sys
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

BACKEND_DIR = Path(__file__).resolve().parent.parent
SOURCE = BACKEND_DIR.parent / "requirements" / "requisitos-exame-graduacao.md"
TARGET = BACKEND_DIR / "src" / "seed_data" / "requirements.json"

_APPENDIX = "## Apêndice A"
_BELT_HEADING = re.compile(
    r"^### \d+\. (?P<belt>.+?) \(\d+º kyū\) — (?P<total>\d+) itens "
    r"\((?P<theory>\d+) teóricos, (?P<practice>\d+) práticos\)$"
)
_CATEGORY = re.compile(r"^\*\*(?P<kind>Prático|Teórico) · (?P<category>.+)\*\*$")
_ITEM = re.compile(r"^- (?P<description>.+?)(?: → \*(?P<expected>.+)\*)?$")
_KINDS = {"Prático": "PRACTICE", "Teórico": "THEORY"}


def parse_appendix(markdown: str) -> list[dict[str, Any]]:
    """Parse Appendix A into requirement records.

    Args:
        markdown: Full content of the requirements document.

    Returns:
        Records with ``belt``, ``kind``, ``category``, ``description``,
        ``expected_answer`` and ``sort_order`` (sheet order within the belt, from 1).

    Raises:
        ValueError: If the appendix is missing, an item has no category, or a
            belt's counts differ from its heading.
    """
    start = markdown.find(_APPENDIX)
    if start < 0:
        raise ValueError("Apêndice A não encontrado")

    records: list[dict[str, Any]] = []
    expected_counts: dict[str, tuple[int, int, int]] = {}
    belt: str | None = None
    kind: str | None = None
    category: str | None = None
    sort_order = 0

    for line in markdown[start:].splitlines():
        line = line.strip()
        if heading := _BELT_HEADING.match(line):
            belt = heading["belt"]
            expected_counts[belt] = (
                int(heading["total"]),
                int(heading["theory"]),
                int(heading["practice"]),
            )
            kind = category = None
            sort_order = 0
        elif section := _CATEGORY.match(line):
            kind = _KINDS[section["kind"]]
            category = section["category"].strip()
        elif belt and (item := _ITEM.match(line)):
            if kind is None or category is None:
                raise ValueError(f"Item sem categoria na faixa {belt}: {line}")
            sort_order += 1
            records.append(
                {
                    "belt": belt,
                    "kind": kind,
                    "category": category,
                    "description": item["description"].strip(),
                    "expected_answer": item["expected"].strip() if item["expected"] else None,
                    "sort_order": sort_order,
                }
            )

    for belt_name, (total, theory, practice) in expected_counts.items():
        items = [r for r in records if r["belt"] == belt_name]
        found = (
            len(items),
            sum(1 for r in items if r["kind"] == "THEORY"),
            sum(1 for r in items if r["kind"] == "PRACTICE"),
        )
        if found != (total, theory, practice):
            raise ValueError(
                f"{belt_name}: esperado {(total, theory, practice)}, encontrado {found}"
            )
    return records


def main() -> int:
    """Write the seed file and report the number of items."""
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    records = parse_appendix(SOURCE.read_text(encoding="utf-8"))
    TARGET.parent.mkdir(parents=True, exist_ok=True)
    TARGET.write_text(
        json.dumps(records, ensure_ascii=False, indent=1) + "\n", encoding="utf-8", newline="\n"
    )
    logger.info("%d itens gravados em %s", len(records), TARGET.relative_to(BACKEND_DIR))
    return 0


if __name__ == "__main__":
    sys.exit(main())
