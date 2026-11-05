"""Path ids: empty or above 1024 UTF-8 bytes answer the resource's 404 (issue #92)."""

import pytest

from domain.errors import NotFoundError
from handlers.http import MAX_PATH_ID_BYTES, path_param

MSG = "Aluno não encontrado"


def _event(value: str | None) -> dict:
    return {"pathParameters": {"id": value}}


def test_path_param_returns_valid_id() -> None:
    assert path_param(_event("abc-123"), "id", not_found=MSG) == "abc-123"


def test_path_param_accepts_exactly_the_limit() -> None:
    value = "a" * MAX_PATH_ID_BYTES
    assert MAX_PATH_ID_BYTES == 1024
    assert path_param(_event(value), "id", not_found=MSG) == value


def test_path_param_accepts_multibyte_at_the_limit() -> None:
    value = "é" * 512  # 1024 bytes
    assert path_param(_event(value), "id", not_found=MSG) == value


@pytest.mark.parametrize(
    "value",
    [
        "",
        None,
        "a" * 1025,
        "é" * 513,  # 513 characters, 1026 bytes: the limit is in bytes
        "\ud800",  # lone surrogate, not encodable in UTF-8
    ],
    ids=["vazio", "ausente", "1025 bytes", "multibyte 1026 bytes", "surrogate"],
)
def test_path_param_refuses_invalid_id_with_resource_message(value: str | None) -> None:
    with pytest.raises(NotFoundError) as exc_info:
        path_param(_event(value), "id", not_found=MSG)
    assert exc_info.value.message == MSG


def test_path_param_refuses_missing_path_parameters() -> None:
    with pytest.raises(NotFoundError):
        path_param({}, "id", not_found=MSG)
