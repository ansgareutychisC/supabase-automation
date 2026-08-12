#!/usr/bin/env python3
"""
Double-fork launcher for the Supabase Onboarding Bridge daemon.

This script launches scripts/run_bridge_aiohttp.py as a double-forked daemon
so it survives bash toolcall boundaries in the sandbox. Without double-forking,
the daemon would be killed when the bash toolcall ends.

The daemon reparents to PID 1 (tini) and runs until:
  - It receives SIGTERM/SIGINT
  - The container recycles (FC scale-to-zero or redeploy)

Usage:
    python scripts/run_bridge.py [--port 8787] [--host 127.0.0.1]

After launch, check the daemon is up:
    curl http://127.0.0.1:8787/health
    cat /tmp/supabase_bridge_ready  # sentinel file

To stop the daemon:
    kill $(cat /tmp/supabase_bridge.pid)
"""
from __future__ import annotations

import argparse
import os
import sys
import time
import json
from pathlib import Path

# Add the project root to sys.path so we can import the bridge module
SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent
sys.path.insert(0, str(PROJECT_ROOT))


def daemonize() -> None:
    """Double-fork the process so it reparents to PID 1 (tini).

    After this returns, we're the grandchild running in a new session,
    detached from the parent's process tree. stdio is redirected to /dev/null.
    """
    # First fork
    if os.fork():
        sys.exit(0)  # parent exits
    # Become session leader
    os.setsid()
    # Second fork
    if os.fork():
        sys.exit(0)  # first child exits; grandchild reparents to PID 1
    # Redirect stdio to /dev/null
    sys.stdout.flush()
    sys.stderr.flush()
    devnull = os.open("/dev/null", os.O_RDWR)
    os.dup2(devnull, 0)
    os.dup2(devnull, 1)
    os.dup2(devnull, 2)


def main() -> int:
    parser = argparse.ArgumentParser(description="Launch the Supabase Onboarding Bridge daemon (double-forked)")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--verbose", action="store_true")
    parser.add_argument("--foreground", action="store_true",
                        help="Run in foreground (don't double-fork). For debugging.")
    args = parser.parse_args()

    # Set env vars for the daemon
    os.environ["BRIDGE_SENTINEL"] = f"/tmp/supabase_bridge_ready_{args.port}"
    pid_file = Path(f"/tmp/supabase_bridge_pid_{args.port}")
    sentinel = Path(os.environ["BRIDGE_SENTINEL"])

    # Clean up any previous sentinel
    sentinel.unlink(missing_ok=True)

    if args.foreground:
        # Run directly - useful for debugging
        print(f"Running bridge in foreground on port {args.port}...")
        os.execvp(sys.executable, [
            sys.executable, str(SCRIPT_DIR / "run_bridge_aiohttp.py"),
            "--host", args.host, "--port", str(args.port),
        ] + (["--verbose"] if args.verbose else []))

    # Double-fork
    print(f"Launching bridge daemon on port {args.port} (double-forked)...")
    daemonize()

    # Write the PID file (we're the grandchild now)
    pid_file.write_text(str(os.getpid()))

    # exec into the bridge server
    os.execvp(sys.executable, [
        sys.executable, str(SCRIPT_DIR / "run_bridge_aiohttp.py"),
        "--host", args.host, "--port", str(args.port),
    ] + (["--verbose"] if args.verbose else []))


if __name__ == "__main__":
    sys.exit(main())
