#!/usr/bin/env python3
"""Supabase onboarding plugin — registers SupabaseDriver into the common daemon.

Plugin contract (docs/DESIGN-PLUGIN-ARCH.md A1): insert BOTH repo roots on
sys.path (this repo + the common repo), import by canonical identities, and
register. No network/IO at import time.
"""
from __future__ import annotations

import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))

if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

_COMMON = os.environ.get(
    "ONBOARD_COMMON_ROOT",
    os.path.join(os.path.dirname(_HERE), "onboard-automation-common"))
if os.path.isdir(_COMMON) and _COMMON not in sys.path:
    sys.path.insert(0, _COMMON)

from backend.api.drivers import register              # noqa: E402
from supabase_onboarding.driver import SupabaseDriver  # noqa: E402

register("supabase", SupabaseDriver)
