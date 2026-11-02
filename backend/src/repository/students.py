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
    MSG_GRADUATION_LOCKED,
    MSG_STUDENT_HAS_EXAMS,
    MSG_STUDENT_NOT_FOUND,
    Student,
)
from repository.tables import (
    NO_EXAMS_CONDITION,
    STUDENTS_TABLE_ENV,
    paginate,
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


def get_student(student_id: str) -> Student | None:
    """Return a student by id, or None."""
    item = table(STUDENTS_TABLE_ENV).get_item(Key={"id": student_id}).get("Item")
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


def save_student(student: Student, *, require_no_exams: bool = False) -> None:
    """Rewrite an existing student's attributes, keeping its ``exam_count``.

    Args:
        student: Student with the new values.
        require_no_exams: Write only while the student has no exam. Used when a
            guardian changes the graduation (RN013), so an attendance confirmed
            after the handler's check still blocks the change.

    Raises:
        NotFoundError: If the student was deleted meanwhile.
        ForbiddenError: If ``require_no_exams`` and the student has an exam.
    """
    arguments = replace_fields(student.to_dict())
    condition = "attribute_exists(id)"
    if require_no_exams:
        condition += f" AND ({NO_EXAMS_CONDITION})"
        arguments["ExpressionAttributeValues"][":zero"] = 0
    students_table = table(STUDENTS_TABLE_ENV)
    try:
        students_table.update_item(**arguments, ConditionExpression=condition)
    except ClientError as exc:
        if exc.response["Error"]["Code"] != "ConditionalCheckFailedException":
            raise
        if students_table.get_item(Key={"id": student.id}).get("Item") is None:
            raise NotFoundError(MSG_STUDENT_NOT_FOUND) from exc
        raise ForbiddenError(MSG_GRADUATION_LOCKED) from exc


def delete_student(student_id: str) -> None:
    """Delete a student only if it has no exam (RN018).

    The condition reads the ``exam_count`` kept by the attendance transaction,
    so an attendance confirmed after any earlier check still blocks the delete.

    Raises:
        ConflictError: If the student has exams.
    """
    try:
        table(STUDENTS_TABLE_ENV).delete_item(
            Key={"id": student_id},
            ConditionExpression=NO_EXAMS_CONDITION,
            ExpressionAttributeValues={":zero": 0},
        )
    except ClientError as exc:
        if exc.response["Error"]["Code"] != "ConditionalCheckFailedException":
            raise
        raise ConflictError(MSG_STUDENT_HAS_EXAMS) from exc
