"""PUT /students/{id}: an edit that changes the graduation is written over the one read.

When the graduation changes, the ``UpdateItem`` also requires the stored belt,
belt date and stripes to be still the ones read (optimistic lock). If they
changed in between (another edit or an approval, RN009), the answer is 409
"Os dados do aluno mudaram. Tente de novo." and nothing is written.
"""

from dataclasses import replace
from datetime import date
from typing import Any

import pytest
from conftest import EXAMINER, api_event, belt_id, make_student, response_json

from domain.errors import ConflictError, NotFoundError
from domain.students import MSG_STUDENT_CHANGED, Student
from handlers import students as student_handlers
from repository import students as student_repo
from repository.tables import STUDENTS_TABLE_ENV, table


def _body(student: Student, **changes: Any) -> dict[str, Any]:
    body = {
        "full_name": student.full_name,
        "birth_date": student.birth_date.isoformat(),
        "current_belt_id": student.current_belt_id,
        "current_belt_since": student.current_belt_since.isoformat(),
        "stripes": student.stripes,
        "federation_id": student.federation_id,
        "active": student.active,
    }
    return body | changes


def _stored(student_id: str) -> dict[str, Any]:
    return table(STUDENTS_TABLE_ENV).get_item(Key={"id": student_id})["Item"]


def _change_between_reads(monkeypatch: pytest.MonkeyPatch, change: Any) -> None:
    """Run ``change`` after the PUT read the student and before it writes."""
    real_check = student_repo.has_exam_in_progress

    def check_after_change(student_id: str) -> bool:
        change()
        return real_check(student_id)

    monkeypatch.setattr(student_repo, "has_exam_in_progress", check_after_change)


@pytest.mark.parametrize(
    "concurrent",
    [
        {"stripes": 2},
        {"current_belt_id": belt_id("Azul")},
        {"current_belt_since": date(2026, 6, 1)},
    ],
)
def test_rn009_graduation_changed_between_read_and_write_is_409(
    seeded: None, monkeypatch: pytest.MonkeyPatch, concurrent: dict[str, Any]
) -> None:
    student = make_student()
    student_repo.create_student(student)
    _change_between_reads(
        monkeypatch, lambda: student_repo.save_student(replace(student, **concurrent))
    )

    response = student_handlers.update_student(
        api_event(
            EXAMINER,
            path={"id": student.id},
            body=_body(student, stripes=1, full_name="Ana Clara"),
        ),
        None,
    )

    assert response["statusCode"] == 409, response["body"]
    assert response_json(response)["message"] == MSG_STUDENT_CHANGED
    stored = _stored(student.id)
    expected = replace(student, **concurrent).to_dict()
    for attribute in student_repo.GRADUATION_ATTRIBUTES:
        assert stored[attribute] == expected[attribute]
    assert stored["full_name"] == "Ana"  # nothing of the stale edit was written


def test_rn009_graduation_edit_over_unchanged_graduation_is_written(seeded: None) -> None:
    student = make_student()
    student_repo.create_student(student)

    response = student_handlers.update_student(
        api_event(EXAMINER, path={"id": student.id}, body=_body(student, stripes=1)), None
    )

    assert response["statusCode"] == 200, response["body"]
    assert int(_stored(student.id)["stripes"]) == 1


def test_rn009_save_student_with_stale_expected_graduation_writes_nothing(seeded: None) -> None:
    student = make_student()
    student_repo.create_student(student)
    student_repo.save_student(replace(student, stripes=2))

    with pytest.raises(ConflictError) as error:
        student_repo.save_student(
            replace(student, stripes=1, full_name="Ana Clara"), expected_graduation=student
        )

    assert error.value.message == MSG_STUDENT_CHANGED
    stored = _stored(student.id)
    assert int(stored["stripes"]) == 2
    assert stored["full_name"] == "Ana"


def test_rn009_save_student_without_graduation_ignores_expected_graduation(
    seeded: None,
) -> None:
    student = make_student()
    student_repo.create_student(student)
    student_repo.save_student(replace(student, stripes=2))

    stored = student_repo.save_student(
        replace(student, full_name="Ana Clara"),
        write_graduation=False,
        expected_graduation=student,
    )

    assert stored.full_name == "Ana Clara"
    assert stored.stripes == 2


def test_rn009_student_deleted_before_graduation_write_is_404(seeded: None) -> None:
    student = make_student()
    student_repo.create_student(student)
    student_repo.delete_student(student.id)

    with pytest.raises(NotFoundError):
        student_repo.save_student(replace(student, stripes=1), expected_graduation=student)
