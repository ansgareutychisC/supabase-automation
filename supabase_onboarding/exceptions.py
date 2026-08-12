"""Custom exceptions for the Supabase onboarding library."""


class SupabaseError(Exception):
    """Base class for all Supabase onboarding errors."""

    def __init__(self, message: str, *, status_code: int | None = None,
                 payload: object = None):
        super().__init__(message)
        self.status_code = status_code
        self.payload = payload


class SupabaseAPIError(SupabaseError):
    """A non-2xx response from a Supabase API endpoint."""


class SupabaseAuthError(SupabaseError):
    """An authentication failure (401/403 from auth.supabase.io or platform API)."""


class SupabaseSignupError(SupabaseError):
    """A failure during the signup flow (e.g. hCaptcha rejected, weak password)."""


class SupabaseVerifyError(SupabaseError):
    """A failure during the email-verification step (e.g. expired token)."""


class ExtensionNotConnectedError(SupabaseError):
    """Raised when an operation requires the Chrome extension but it's not connected."""


class ExtensionTimeoutError(SupabaseError):
    """Raised when a command sent to the Chrome extension times out."""


__all__ = [
    "SupabaseError",
    "SupabaseAPIError",
    "SupabaseAuthError",
    "SupabaseSignupError",
    "SupabaseVerifyError",
    "ExtensionNotConnectedError",
    "ExtensionTimeoutError",
]
