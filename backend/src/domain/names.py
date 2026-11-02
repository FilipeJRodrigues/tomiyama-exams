"""Alphabetical ordering of people's names, independent of the system locale."""

import unicodedata


def fold_name(name: str) -> str:
    """Return the name without accents and case, for comparison.

    ``NFKD`` splits each accented letter into the base letter plus combining
    marks, which are then dropped; ``casefold`` removes case. "Álvaro" becomes
    "alvaro", so it sorts before "bruno" instead of after "zélia".
    """
    decomposed = unicodedata.normalize("NFKD", name)
    stripped = "".join(char for char in decomposed if not unicodedata.combining(char))
    return stripped.casefold()


def name_sort_key(name: str | None, item_id: str) -> tuple[str, str, str]:
    """Return a sort key: folded name, then the original name, then the id.

    The tie-breakers keep the order stable for names that fold to the same
    text ("Erica" and "Érica") and for homonyms.

    Args:
        name: Name shown in the list (None sorts as an empty name).
        item_id: Id of the item, the last tie-breaker.
    """
    original = name or ""
    return (fold_name(original), original, item_id)
