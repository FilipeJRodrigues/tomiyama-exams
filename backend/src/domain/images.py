"""Academy images (RN012): validation of an upload and the metadata kept about it.

Shared by the logos and the certificate signatures (``domain.signatures``): both
are PNG or JPEG of at most 2 MB, sent through the API as JSON with the bytes in
base64, stored in a private S3 bucket and read through a short-lived presigned
URL. Nothing here touches AWS.

The real type comes from the file's first bytes (its binary signature), never
only from the declared ``content_type``; if they disagree the upload is refused.
"""

import base64
import binascii
from dataclasses import dataclass
from typing import Any

from domain.errors import ValidationError

PNG = "image/png"
JPEG = "image/jpeg"
CONTENT_TYPES = (PNG, JPEG)

# File signatures ("magic numbers") of each accepted type.
_SIGNATURES = {
    PNG: b"\x89PNG\r\n\x1a\n",
    JPEG: b"\xff\xd8\xff",
}

# Extension of the fixed file name the browser sees for each type.
_EXTENSIONS = {PNG: "png", JPEG: "jpg"}

# 2 MB = 2 MiB, counted on the decoded bytes.
MAX_IMAGE_BYTES = 2 * 1024 * 1024
# Longest base64 text that can decode to MAX_IMAGE_BYTES (4 chars per 3 bytes,
# padded): anything longer is refused before decoding.
MAX_BASE64_CHARS = 4 * -(-MAX_IMAGE_BYTES // 3)

# Validity of the presigned GET URL returned to the screen.
PRESIGNED_URL_SECONDS = 300

MSG_INVALID_IMAGE = "Envie PNG ou JPEG de até 2 MB"


@dataclass(frozen=True)
class ImageUpload:
    """A validated image ready to be stored."""

    content_type: str
    data: bytes

    @property
    def size(self) -> int:
        """Size of the decoded file in bytes."""
        return len(self.data)


@dataclass(frozen=True)
class ImageMeta:
    """What is kept in DynamoDB about a stored image (never the bytes)."""

    content_type: str
    size: int
    updated_at: str
    updated_by: str

    def to_dict(self) -> dict[str, Any]:
        """Return the stored (and returned) fields."""
        return {
            "content_type": self.content_type,
            "size": self.size,
            "updated_at": self.updated_at,
            "updated_by": self.updated_by,
        }

    @classmethod
    def from_dict(cls, value: Any) -> "ImageMeta | None":
        """Rebuild the metadata from a stored map; None if absent or malformed.

        A type other than PNG or JPEG counts as malformed: it would be served
        as the response's ``Content-Type``.
        """
        if not isinstance(value, dict):
            return None
        if value.get("content_type") not in CONTENT_TYPES:
            return None
        try:
            return cls(
                content_type=str(value["content_type"]),
                size=int(value["size"]),
                updated_at=str(value["updated_at"]),
                updated_by=str(value["updated_by"]),
            )
        except (KeyError, TypeError, ValueError):
            return None


def detect_content_type(data: bytes) -> str | None:
    """Return the type given by the file signature, or None if neither PNG nor JPEG."""
    return next(
        (kind for kind, signature in _SIGNATURES.items() if data.startswith(signature)),
        None,
    )


def parse_image_upload(payload: dict[str, Any]) -> ImageUpload:
    """Validate an upload body ``{"content_type": ..., "data": "<base64>"}`` (RN012).

    Args:
        payload: The request body.

    Returns:
        The decoded image.

    Raises:
        ValidationError: ``MSG_INVALID_IMAGE`` if the declared type is not PNG
            or JPEG, ``data`` is not strict base64 (no data-URL prefix, no
            line breaks), is empty, is larger than 2 MB once decoded, or its
            bytes are not of the declared type.
    """
    content_type = payload.get("content_type")
    data = payload.get("data")
    if content_type not in CONTENT_TYPES or not isinstance(data, str):
        raise ValidationError(MSG_INVALID_IMAGE)
    if not data or len(data) > MAX_BASE64_CHARS:
        raise ValidationError(MSG_INVALID_IMAGE)
    try:
        decoded = base64.b64decode(data, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValidationError(MSG_INVALID_IMAGE) from exc
    if not decoded or len(decoded) > MAX_IMAGE_BYTES:
        raise ValidationError(MSG_INVALID_IMAGE)
    detected = detect_content_type(decoded)
    if detected is None or detected != content_type:
        raise ValidationError(MSG_INVALID_IMAGE)
    # The stored type is the one read from the bytes, never the client's text.
    return ImageUpload(content_type=detected, data=decoded)


def content_disposition(content_type: str, basename: str) -> str:
    """Return the ``Content-Disposition`` an image is stored and served with.

    Always ``inline`` (shown, never downloaded as another kind of file) with a
    fixed file name chosen by the code, e.g. ``inline; filename="logo.png"``;
    nothing typed by the user goes into the header.

    Args:
        content_type: ``image/png`` or ``image/jpeg``.
        basename: Fixed name without extension (lowercase letters only).

    Raises:
        ValueError: If the type or the name is not one of the expected values
            (a programming error, not user input).
    """
    if content_type not in _EXTENSIONS:
        raise ValueError(f"unexpected image type: {content_type!r}")
    if not basename.isascii() or not basename.isalpha() or not basename.islower():
        raise ValueError(f"unsafe file name: {basename!r}")
    return f'inline; filename="{basename}.{_EXTENSIONS[content_type]}"'
