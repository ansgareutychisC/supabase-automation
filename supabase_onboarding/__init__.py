"""
Supabase Onboarding Automation.

Automate the full Supabase account lifecycle — signup → email verify →
create profile → create org → generate PAT — via a mix of plain HTTP
calls and (only for the hCaptcha-protected signup step) a Chrome
extension bridge.

Public API:
    from supabase_onboarding import (
        SupabasePlatformClient,
        SignupClient,
        EmailWorkerClient,
        OnboardingAutomation,
        ExtensionBridge,
    )
"""

from .exceptions import (
    SupabaseError,
    SupabaseAPIError,
    SupabaseAuthError,
    SupabaseSignupError,
    SupabaseVerifyError,
    ExtensionNotConnectedError,
    ExtensionTimeoutError,
)
from .signup.email_worker import EmailWorkerClient, EmailWorkerError, VerificationEmail
from .signup.client import SignupClient, SignupResult
from .client import SupabasePlatformClient
from .profile import create_profile, get_profile, PlatformProfile
from .organization import create_organization, list_organizations, Organization
from .access_token import create_access_token, list_access_tokens, AccessToken
from .onboarding import OnboardingAutomation, OnboardingReport
from .token_manager import TokenManager, TokenSet

__all__ = [
    # Exceptions
    "SupabaseError",
    "SupabaseAPIError",
    "SupabaseAuthError",
    "SupabaseSignupError",
    "SupabaseVerifyError",
    "ExtensionNotConnectedError",
    "ExtensionTimeoutError",
    # Email worker
    "EmailWorkerClient",
    "EmailWorkerError",
    "VerificationEmail",
    # Signup
    "SignupClient",
    "SignupResult",
    # Platform client
    "SupabasePlatformClient",
    # Resources
    "PlatformProfile",
    "Organization",
    "AccessToken",
    # Operations
    "create_profile",
    "get_profile",
    "create_organization",
    "list_organizations",
    "create_access_token",
    "list_access_tokens",
    # High-level facade
    "OnboardingAutomation",
    "OnboardingReport",
]

# ExtensionBridge is optional (requires aiohttp) — try-import
try:
    from .extension_bridge import ExtensionBridge, CommandResult
    __all__ += ["ExtensionBridge", "CommandResult"]
except ImportError:  # pragma: no cover
    pass
