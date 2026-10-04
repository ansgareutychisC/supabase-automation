"""SupabaseDriver unit tests — plugin contract + provision mapping (no network)."""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))

COMMON = os.environ.get(
    "ONBOARD_COMMON_ROOT",
    str(REPO.parent / "onboard-automation-common"))
if os.path.isdir(COMMON) and COMMON not in sys.path:
    sys.path.insert(0, COMMON)

from supabase_onboarding.driver import SupabaseDriver   # noqa: E402


class TestPluginContract:
    def test_onboard_driver_registers(self):
        common = REPO.parent / "onboard-automation-common"
        if not common.is_dir():
            pytest.skip("common repo not cloned as sibling")
        from backend.api import drivers as drvmod
        before = drvmod.REGISTRY.get("supabase")
        try:
            import importlib.util
            spec = importlib.util.spec_from_file_location(
                "onboard_plugin_test_sb", REPO / "onboard_driver.py")
            mod = importlib.util.module_from_spec(spec)
            sys.modules["onboard_plugin_test_sb"] = mod
            spec.loader.exec_module(mod)
            from backend.api.drivers import REGISTRY
            assert "supabase" in REGISTRY
        finally:
            if before is None:
                drvmod.REGISTRY.pop("supabase", None)
            sys.modules.pop("onboard_plugin_test_sb", None)


class TestSession:
    def test_init_session_shape(self, tmp_path):
        d = SupabaseDriver()
        sess = d.init_session(
            {"email": "a@v3-mail.priv.email", "userId": "uuid-1",
             "accessToken": "jwt", "refreshToken": "rt"},
            str(tmp_path / "s.json"))
        assert sess["service"] == "supabase"
        assert sess["accessToken"] == "jwt"
        assert os.path.exists(tmp_path / "s.json")


class TestProvision:
    def test_provision_maps_report_and_persists_pat(self, tmp_path, monkeypatch):
        d = SupabaseDriver()
        spath = str(tmp_path / "s.json")
        d.init_session({"email": "a@x", "userId": "u",
                        "accessToken": "jwt-expiring"}, spath)

        class FakeReport:
            profile_id = "p1"
            org_id = 5
            org_slug = "kcytestslug"
            org_name = "a@x's Org"
            plan_id = "tier_free"
            pat = "sbp_secret_pat_value"
            pat_alias = "sbp_1234…5678"
            pat_expires_at = "2027-10-04"
            email = "a@x"
            errors = []

        class FakeOA:
            @classmethod
            def for_existing_token(cls, token):
                assert token == "sbp_prior_pat"      # PAT preferred over JWT
                return cls()
            def ensure_profile_org_pat(self, **kw):
                return FakeReport()

        import supabase_onboarding.driver as drv
        monkeypatch.setattr(drv, "_ensure_pkg", lambda: (FakeOA, None, None))

        from backend.api.drivers.base import TailOptions
        creds = {"pat": "sbp_prior_pat", "email": "a@x", "userId": "u"}
        out = d.provision(creds, spath, TailOptions())
        by = {o["label"]: o["result"] for o in out["outcomes"]}
        assert by["profile"]["ok"] and by["org"]["ok"] and by["pat"]["ok"]
        assert by["org"]["detail"] == "kcytestslug"
        # session persisted the org + pat
        sess = json.load(open(spath))
        assert sess["org"]["slug"] == "kcytestslug"
        assert sess["pat"] == "sbp_secret_pat_value"
        # creds dict got the round-trip fields
        assert creds["org"]["slug"] == "kcytestslug"

    def test_provision_errors_surfaced(self, tmp_path, monkeypatch):
        d = SupabaseDriver()
        spath = str(tmp_path / "s.json")
        d.init_session({"email": "a@x", "userId": "u",
                        "accessToken": "jwt"}, spath)

        class FakeReport:
            profile_id = None
            org_id = None
            pat = None
            errors = ["profile: boom"]

        class FakeOA:
            @classmethod
            def for_existing_token(cls, token):
                return cls()
            def ensure_profile_org_pat(self, **kw):
                return FakeReport()

        import supabase_onboarding.driver as drv
        monkeypatch.setattr(drv, "_ensure_pkg", lambda: (FakeOA, None, None))
        from backend.api.drivers.base import TailOptions
        out = d.provision({"accessToken": "jwt"}, spath, TailOptions())
        by = {o["label"]: o["result"] for o in out["outcomes"]}
        assert by["profile"]["ok"] is False
        assert "boom" in by["errors"]["error"]


class TestChat:
    def test_chat_raises_default(self):
        from backend.api.drivers.base import ChatOptions
        with pytest.raises(RuntimeError, match="does not support chat"):
            SupabaseDriver().chat({}, "/tmp/x.json", ChatOptions(prompt="hi"))
