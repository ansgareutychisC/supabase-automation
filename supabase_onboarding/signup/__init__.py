"""Signup subpackage - account creation + email verification."""

from .client import SignupClient, SignupResult
from .email_worker import (
    EmailWorkerClient,
    EmailWorkerError,
    VerificationEmail,
)

__all__ = [
    "SignupClient",
    "SignupResult",
    "EmailWorkerClient",
    "EmailWorkerError",
    "VerificationEmail",
]
