"""Persistence of students in the ``Students`` table.

Keys: PK ``id``; GSI ``by_owner`` (PK ``owner_id``) lists a guardian's students.
"""

from datetime import date
from typing import Any

from boto3.dynamodb.conditions import Key

from domain.students import Student
from repository.tables import STUDENTS_TABLE_ENV, paginate, table

BY_OWNER_INDEX = "by_owner"


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


def save_student(student: Student) -> None:
    """Replace an existing student."""
    table(STUDENTS_TABLE_ENV).put_item(
        Item=_to_item(student), ConditionExpression="attribute_exists(id)"
    )


def delete_student(student_id: str) -> None:
    """Delete a student by id."""
    table(STUDENTS_TABLE_ENV).delete_item(Key={"id": student_id})
