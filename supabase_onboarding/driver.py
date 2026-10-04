"""SupabaseDriver — the Supabase onboarding plugin for the common daemon.

Signup (browser, hCaptcha gate):
  POST api.supabase.com/platform/signup requires an hCaptcha token — the
  SPA form runs it in-page; warm-browser cascade
  (scripts/supabase_signup_warm.js) submits the form and detects the 201.

Verify + tokens (plain HTTP, recovered SignupClient.verify_only):
  v3-mail poll -> verify link (strip redirect_to — known Supabase bug
  workaround) -> 303 Location fragment #access_token=<JWT>&refresh_token=…
  -> get_user confirms the session. NO browser needed after the 201.

Provision (plain HTTP, recovered OnboardingAutomation.ensure_profile_org_pat):
  platform profile -> personal org (tier_free) -> sbp_ PAT.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
from typing import Any

from backend.api import config
from backend.api.drivers.base import (ServiceDriver, SignupOptions,
                                      TailOptions, _never_cancel, _noop)

_REPO_ROOT = os.path.dirname(os.path.dirname(
    os.path.abspath(__file__)))           # <repo>/supabase_onboarding/driver.py
_WARM_JS = os.path.join(_REPO_ROOT, "scripts", "supabase_signup_warm.js")

# ---- plugin-local mail config (A8) ----------------------------------------
# v3-mail v1 API — live + delivering; supabase accepts the privatimail
# family (Oct-3 HAR captures used @privatimail.com).
MAIL_BASE = os.environ.get(
    "SUPABASE_MAIL_BASE", "https://v3-mail.priv.email")
MAIL_TOKEN = os.environ.get(
    "SUPABASE_MAIL_TOKEN",
    "a2df50bf1d1310903061cdd569b6a20a62717998dcfe52bf")
MAIL_DOMAIN = os.environ.get(
    "SUPABASE_MAIL_DOMAIN", "v3-mail.priv.email")


def _evt(on_event, kind: str, **detail) -> None:
    try:
        on_event(kind, detail)
    except Exception:                                    # pragma: no cover
        pass


def _ensure_pkg():
    if _REPO_ROOT not in sys.path:
        sys.path.insert(0, _REPO_ROOT)
    from supabase_onboarding.onboarding import OnboardingAutomation
    from supabase_onboarding.signup.client import SignupClient
    from supabase_onboarding.signup.email_worker import EmailWorkerClient
    return OnboardingAutomation, SignupClient, EmailWorkerClient


class SupabaseDriver(ServiceDriver):
    name = "supabase"

    # ------------------------------------------------------------- health
    def health(self) -> dict:
        out: dict[str, Any] = {
            "node": bool(shutil.which("node")),
            "playwright": os.path.isdir(os.path.join(config.NODE_PATH, "playwright")),
            "zenrows_key": bool(config.ZENROWS_API_KEY),
            "warm_driver": os.path.exists(_WARM_JS),
            "mail_domain": MAIL_DOMAIN,
        }
        try:
            _ensure_pkg()
            out["pkg_import"] = True
        except Exception as e:                           # pragma: no cover
            out["pkg_import"] = f"FAIL: {e}"
            out["ok"] = False
            return out
        import requests
        try:
            r = requests.get(
                f"{MAIL_BASE}/emails",
                params={"address": f"health@{MAIL_DOMAIN}", "limit": 1},
                headers={"Authorization": f"Bearer {MAIL_TOKEN}"},
                timeout=10)
            out["mail_api"] = (r.status_code == 200)
        except Exception as e:                           # pragma: no cover
            out["mail_api"] = f"FAIL: {e}"[:120]
        out["ok"] = all(v is True for k, v in out.items() if isinstance(v, bool))
        return out

    # ------------------------------------------------------------ signup
    def signup(self, opts: SignupOptions, on_event=_noop,
               cancel_fn=_never_cancel) -> dict:
        OnboardingAutomation, SignupClient, EmailWorkerClient = _ensure_pkg()
        out = os.path.join(config.DATA_DIR,
                           f"supabase_creds_{os.getpid()}_{int(time.time())}.json")
        tier = os.environ.get("SUPABASE_TIER", "auto")
        cmd = ["node", _WARM_JS, "--attempts", str(opts.attempts),
               "--country", opts.country, "--tier", tier, "--out", out]
        if opts.email:
            cmd += ["--email", opts.email]
        env = dict(os.environ)
        env["NODE_PATH"] = config.NODE_PATH + os.pathsep + env.get("NODE_PATH", "")
        env["ONBOARD_COMMON_ROOT"] = os.environ.get(
            "ONBOARD_COMMON_ROOT",
            os.path.join(os.path.dirname(_REPO_ROOT), "onboard-automation-common"))
        env["SUPABASE_MAIL_DOMAIN"] = MAIL_DOMAIN
        _evt(on_event, "signup_start", email=opts.email,
             country=opts.country, tier=tier)
        t0 = time.time()
        try:
            proc = subprocess.Popen(
                cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                text=True, env=env, cwd=_REPO_ROOT)
            deadline = time.time() + 900
            while True:
                try:
                    p_out, _ = proc.communicate(timeout=5)
                    break
                except subprocess.TimeoutExpired:
                    if cancel_fn and cancel_fn():
                        proc.kill()
                        proc.wait()
                        raise RuntimeError("signup cancelled")
                    if time.time() > deadline:
                        proc.kill()
                        proc.wait()
                        raise RuntimeError("warm signup timed out (900s)")
            tail = "\n".join((p_out or "").splitlines()[-12:])
            if proc.returncode != 0 or not os.path.exists(out):
                raise RuntimeError(
                    f"warm signup failed rc={proc.returncode} after "
                    f"{time.time()-t0:.0f}s:\n{tail}")
            with open(out) as f:
                creds = json.load(f)
        finally:
            try:
                os.unlink(out)
            except OSError:
                pass

        # ---- verify (plain HTTP): poll v3-mail -> follow link -> tokens ----
        _evt(on_event, "verify_start", email=creds["email"])
        ew = EmailWorkerClient(base_url=MAIL_BASE, token=MAIL_TOKEN)
        result = SignupClient().verify_only(
            creds["email"], ew, email_wait_timeout=180)
        if not result.access_token:
            raise RuntimeError("verify_only returned no access_token")
        creds.update({
            "userId": result.user_id,
            "emailConfirmedAt": result.email_confirmed_at,
            "accessToken": result.access_token,
            "refreshToken": result.refresh_token,
            "expiresAt": result.expires_at,
            # legacy column mapping (A3): token_v2 <- PAT once provisioned;
            # for now the GoTrue access token
            "tokenV2": result.access_token,
        })
        creds.setdefault("proxyCountry", opts.country)
        creds.setdefault("service", self.name)
        _evt(on_event, "signup_done", email=creds["email"],
             ip=creds.get("signupIp"), country=creds.get("proxyCountry"),
             userId=result.user_id[:8] + "…",
             seconds=round(time.time() - t0, 1))
        return creds

    # ---------------------------------------------------- session files
    def init_session(self, creds: dict, session_path: str) -> dict:
        sess = {
            "service": self.name,
            "email": creds.get("email", ""),
            "userId": creds.get("userId", ""),
            "accessToken": creds.get("accessToken", ""),
            "refreshToken": creds.get("refreshToken", ""),
            "pat": creds.get("pat", ""),
            "org": creds.get("org") or {},
            "createdAt": time.time(),
        }
        os.makedirs(os.path.dirname(session_path), exist_ok=True)
        with open(session_path, "w") as f:
            json.dump(sess, f, indent=2)
        return sess

    def _load_or_init(self, creds: dict, session_path: str) -> dict:
        if os.path.exists(session_path):
            with open(session_path) as f:
                return json.load(f)
        return self.init_session(creds, session_path)

    # -------------------------------------------------------- provision
    def provision(self, creds: dict, session_path: str, opts: TailOptions,
                  on_event=_noop) -> dict:
        OnboardingAutomation, _, _ = _ensure_pkg()
        sess = self._load_or_init(creds, session_path)
        # token preference: PAT (long-lived) > access_token (30 min JWT)
        token = creds.get("pat") or sess.get("pat") or \
            creds.get("accessToken") or sess.get("accessToken")
        if not token:
            raise RuntimeError("no access token in creds/session — cannot provision")

        _evt(on_event, "tail_start")
        t0 = time.time()
        auto = OnboardingAutomation.for_existing_token(token)
        report = auto.ensure_profile_org_pat(
            pat_name="automation-token", pat_expires_in_days=365,
            org_name=opts.workspace_name or None)

        outcomes = []
        r = report  # OnboardingReport dataclass
        for label, ok, detail in [
            ("profile", bool(getattr(r, "profile_id", None)),
             str(getattr(r, "email", "") or "")),
            ("org", bool(getattr(r, "org_id", None)),
             str(getattr(r, "org_slug", "") or "")),
            ("pat", bool(getattr(r, "pat", None)),
             str(getattr(r, "pat_alias", "") or "")),
        ]:
            item = {"ok": bool(ok)}
            if detail and ok:
                item["detail"] = detail[:120]
            outcomes.append({"label": label, "result": item})
        errors = list(getattr(r, "errors", None) or [])
        if errors:
            outcomes.append({"label": "errors", "result": {
                "ok": False, "error": "; ".join(errors)[:300]}})

        # persist the PAT + org into the session + creds round-trip
        if getattr(r, "pat", None):
            sess["pat"] = r.pat
            sess["patExpiresAt"] = getattr(r, "pat_expires_at", "")
            creds["pat"] = r.pat                     # creds_json round-trip
        if getattr(r, "org_slug", None):
            sess["org"] = {"id": r.org_id, "slug": r.org_slug,
                           "name": r.org_name, "plan": r.plan_id}
            creds["org"] = sess["org"]
        with open(session_path, "w") as f:
            json.dump(sess, f, indent=2)
        _evt(on_event, "tail_done", seconds=round(time.time() - t0, 1))
        return {"outcomes": outcomes, "session": sess}

    # ------------------------------------------------------------- chat
    # (default implementation raises "does not support chat" — correct)
