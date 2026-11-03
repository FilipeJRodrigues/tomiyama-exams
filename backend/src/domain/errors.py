"""Domain errors mapped to HTTP status codes by the handlers layer."""

# 503 message shared by every AWS service that may throttle (DynamoDB, Cognito).
MSG_SERVICE_BUSY = "Sistema ocupado no momento. Tente de novo em instantes."


class DomainError(Exception):
    """Base class for business rule violations.

    Attributes:
        status_code: HTTP status the API returns for this error.
        message: User-facing message in pt-BR.
    """

    status_code: int = 400

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


class ValidationError(DomainError):
    """Invalid input data (400)."""

    status_code = 400


class UnauthorizedError(DomainError):
    """Missing or invalid authentication (401)."""

    status_code = 401


class ForbiddenError(DomainError):
    """Authenticated user lacks permission (403)."""

    status_code = 403


class NotFoundError(DomainError):
    """Resource missing or not visible to the user (404)."""

    status_code = 404


class ConflictError(DomainError):
    """Uniqueness or state conflict (409)."""

    status_code = 409


class PayloadTooLargeError(DomainError):
    """Request body above the size the API accepts (413)."""

    status_code = 413


class ServiceUnavailableError(DomainError):
    """Temporary lack of capacity; the same request may succeed later (503)."""

    status_code = 503
