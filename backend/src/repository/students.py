"""Persistence of students in the ``Students`` table.

Keys: PK ``id``; GSI ``by_owner`` (PK ``owner_id``) lists a guardian's students.
"""

from collections.abc import Iterable
from datetime import date
from typing import Any

from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

from domain.errors import ConflictError, ForbiddenError, NotFoundError
from domain.students import (
    MSG_GRADUATION_IN_PROGRESS,
    MSG_GRADUATION_LOCKED,
    MSG_STUDENT_CHANGED,
    MSG_STUDENT_HAS_EXAMS,
    MSG_STUDENT_NOT_FOUND,
    Student,
)
from repository.tables import (
    EXAM_COUNT,
    EXAM_IN_PROGRESS,
    NO_EXAMS_CONDITION,
    STUDENTS_TABLE_ENV,
    get_item_or_busy,
    paginate,
    raise_if_throttled,
    replace_fields,
    table,
)

BY_OWNER_INDEX = "by_owner"
_BATCH_GET_LIMIT = 100


def _to_item(student: Student) -> dict[str, Any]:
    item = student.to_dict()
    return {key: value for key, value in item.items() if value is not None}


def _from_item(item: dict[str, Any]) -> Student:
    return Student(
        id=item["id"],
        owner_id=item["owner_id"],
        full_name=item["full_name"],
        birth_date=date.fromisoformat(item["birth_date"]),
        current_belt_id=item["current_belt_id"],
        current_belt_since=date.fromisoformat(item["current_belt_since"]),
        stripes=int(item.get("stripes", 0)),
        federation_id=item.get("federation_id"),
        active=bool(item.get("active", True)),
        created_at=item["created_at"],
        updated_at=item["updated_at"],
    )


# Graduation attributes (RN013): left out of the write when an edit keeps them.
GRADUATION_ATTRIBUTES = ("current_belt_id", "current_belt_since", "stripes")


def _graduation_of(student: Student) -> dict[str, Any]:
    """Return the graduation attributes as stored (same serialization as ``_to_item``)."""
    item = student.to_dict()
    return {attribute: item[attribute] for attribute in GRADUATION_ATTRIBUTES}


def get_student(student_id: str) -> Student | None:
    """Return a student by id, or None.

    Raises:
        ServiceUnavailableError: If the table kept throttling (503).
    """
    item = get_item_or_busy(table(STUDENTS_TABLE_ENV), {"id": student_id})
    return _from_item(item) if item else None


def get_names(student_ids: Iterable[str]) -> dict[str, str]:
    """Return ``{id: full_name}`` for the given students (missing ids are left out).

    Reads only the two attributes with ``BatchGetItem``, 100 keys per call,
    retrying unprocessed keys.
    """
    ids = sorted(set(student_ids))
    names: dict[str, str] = {}
    students_table = table(STUDENTS_TABLE_ENV)
    client = students_table.meta.client
    for start in range(0, len(ids), _BATCH_GET_LIMIT):
        request: dict[str, Any] = {
            students_table.name: {
                "Keys": [
                    {"id": student_id} for student_id in ids[start : start + _BATCH_GET_LIMIT]
                ],
                "ProjectionExpression": "#id, full_name",
                "ExpressionAttributeNames": {"#id": "id"},
            }
        }
        while request:
            response = client.batch_get_item(RequestItems=request)
            for item in response.get("Responses", {}).get(students_table.name, []):
                names[item["id"]] = item["full_name"]
            request = response.get("UnprocessedKeys") or {}
    return names


def list_all() -> list[Student]:
    """Return every student (at most a few hundred items)."""
    return [_from_item(item) for item in paginate(table(STUDENTS_TABLE_ENV).scan)]


def list_by_owner(owner_id: str) -> list[Student]:
    """Return the students registered by a guardian."""
    items = paginate(
        table(STUDENTS_TABLE_ENV).query,
        IndexName=BY_OWNER_INDEX,
        KeyConditionExpression=Key("owner_id").eq(owner_id),
    )
    return [_from_item(item) for item in items]


def create_student(student: Student) -> None:
    """Insert a new student."""
    table(STUDENTS_TABLE_ENV).put_item(
        Item=_to_item(student), ConditionExpression="attribute_not_exists(id)"
    )


def has_exam_in_progress(student_id: str) -> bool:
    """Return whether the student carries the ``exam_in_progress_id`` marker (RN005).

    Raises:
        ServiceUnavailableError: If the table kept throttling (503).
    """
    item = get_item_or_busy(
        table(STUDENTS_TABLE_ENV), {"id": student_id}, ProjectionExpression=EXAM_IN_PROGRESS
    )
    return bool(item and item.get(EXAM_IN_PROGRESS))


def save_student(
    student: Student,
    *,
    require_no_exams: bool = False,
    require_no_exam_in_progress: bool = False,
    write_graduation: bool = True,
    expected_graduation: Student | None = None,
) -> Student:
    """Rewrite an existing student's attributes, keeping ``exam_count`` and the marker.

    Args:
        student: Student with the new values.
        require_no_exams: Write only while the student has no exam. Used when a
            guardian changes the graduation (RN013), so an attendance confirmed
            after the handler's check still blocks the change.
        require_no_exam_in_progress: Write only while the student has no exam
            in progress (no ``exam_in_progress_id``). Used whenever the
            graduation changes (RN005), for the same race.
        write_graduation: Also write the belt, the belt date and the stripes.
            False when the edit keeps them: the stored graduation then stays
            as it is, so an approval written after the caller's read is never
            reverted by an edit of the other fields (RN009).
        expected_graduation: Student as the caller read it. With
            ``write_graduation``, write only while the stored belt, belt date
            and stripes are still the ones read (optimistic lock), so an
            approval written after the read is never reverted by an edit that
            changes the graduation (RN009).

    Returns:
        The student as stored after the write.

    Raises:
        NotFoundError: If the student was deleted meanwhile.
        ForbiddenError: If ``require_no_exams`` and the student has an exam
            (wins over the exam in progress, as in ``domain.students``).
        ConflictError: If ``require_no_exam_in_progress`` and the student has
            an exam in progress, or if the stored graduation is no longer
            ``expected_graduation``'s.
        ServiceUnavailableError: If the write, or the re-read after a failed
            condition, kept throttling (503).
    """
    fields = student.to_dict()
    if not write_graduation:
        for attribute in GRADUATION_ATTRIBUTES:
            del fields[attribute]
    arguments = replace_fields(fields)
    condition = "attribute_exists(id)"
    if require_no_exams:
        condition += f" AND ({NO_EXAMS_CONDITION})"
        arguments["ExpressionAttributeValues"][":zero"] = 0
    if require_no_exam_in_progress:
        condition += f" AND attribute_not_exists({EXAM_IN_PROGRESS})"
    expected = (
        _graduation_of(expected_graduation)
        if write_graduation and expected_graduation is not None
        else None
    )
    if expected is not None:
        for index, (attribute, value) in enumerate(expected.items()):
            arguments["ExpressionAttributeNames"][f"#g{index}"] = attribute
            arguments["ExpressionAttributeValues"][f":g{index}"] = value
            condition += f" AND #g{index} = :g{index}"
    students_table = table(STUDENTS_TABLE_ENV)
    try:
        response = students_table.update_item(
            **arguments, ConditionExpression=condition, ReturnValues="ALL_NEW"
        )
    except ClientError as exc:
        if exc.response["Error"]["Code"] != "ConditionalCheckFailedException":
            raise_if_throttled(exc, "UpdateItem on Students")
            raise
        item = get_item_or_busy(students_table, {"id": student.id})
        if item is None:
            raise NotFoundError(MSG_STUDENT_NOT_FOUND) from exc
        if require_no_exams and int(item.get(EXAM_COUNT, 0)) > 0:
            raise ForbiddenError(MSG_GRADUATION_LOCKED) from exc
        if require_no_exam_in_progress and item.get(EXAM_IN_PROGRESS):
            raise ConflictError(MSG_GRADUATION_IN_PROGRESS) from exc
        if expected is not None and any(
            item.get(attribute) != value for attribute, value in expected.items()
        ):
            raise ConflictError(MSG_STUDENT_CHANGED) from exc
        # The blocking state is gone by the re-read (e.g. the exam was decided
        # in between); report the lock the write actually checked.
        if require_no_exams:
            raise ForbiddenError(MSG_GRADUATION_LOCKED) from exc
        raise ConflictError(MSG_GRADUATION_IN_PROGRESS) from exc
    return _from_item(response["Attributes"])


def delete_student(student_id: str) -> None:
    """Delete a student only if it has no exam (RN018).

    The condition reads the ``exam_count`` kept by the attendance transaction,
    so an attendance confirmed after any earlier check still blocks the delete.

    Raises:
        ConflictError: If the student has exams.
        ServiceUnavailableError: If the delete kept throttling (503).
    """
    try:
        table(STUDENTS_TABLE_ENV).delete_item(
            Key={"id": student_id},
            ConditionExpression=NO_EXAMS_CONDITION,
            ExpressionAttributeValues={":zero": 0},
        )
    except ClientError as exc:
        if exc.response["Error"]["Code"] != "ConditionalCheckFailedException":
            raise_if_throttled(exc, "DeleteItem on Students")
            raise
        raise ConflictError(MSG_STUDENT_HAS_EXAMS) from exc
