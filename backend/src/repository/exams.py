"""Persistence of exams in the ``Exams`` table.

Keys: PK ``event_id``, SK ``student_id`` (one exam per event and student);
GSI ``by_student`` (PK ``student_id``, SK ``event_id``) for a student's history.
"""

from boto3.dynamodb.conditions import Key

from repository.tables import EXAMS_TABLE_ENV, table

BY_STUDENT_INDEX = "by_student"


def student_has_exams(student_id: str) -> bool:
    """Return whether the student has at least one exam."""
    response = table(EXAMS_TABLE_ENV).query(
        IndexName=BY_STUDENT_INDEX,
        KeyConditionExpression=Key("student_id").eq(student_id),
        Limit=1,
    )
    return bool(response.get("Items"))
