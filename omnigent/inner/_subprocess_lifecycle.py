"""Force-close asyncio subprocess transports before loop teardown.

``asyncio.subprocess.Process.wait()`` returns when the subprocess exits,
but the transport is only marked ``_closed`` when something calls
``transport.close()`` explicitly. If the test event loop closes first,
GC later calls ``BaseSubprocessTransport.__del__`` which does
``self._loop.call_soon(...)`` on a closed loop and raises
``RuntimeError('Event loop is closed')``.

``_transport`` is a stable private attr on
``asyncio.subprocess.Process`` across CPython 3.10+.
"""

from __future__ import annotations

import contextlib
import logging
import os
import shlex
import subprocess
from typing import Any

_logger = logging.getLogger(__name__)


def close_subprocess_transport(proc: Any) -> None:  # type: ignore[explicit-any]
    """Force-close ``proc._transport``. Safe on missing/already-closed."""
    transport = getattr(proc, "_transport", None)
    if transport is None:
        return
    is_closing = getattr(transport, "is_closing", None)
    if callable(is_closing) and is_closing():
        return
    with contextlib.suppress(Exception):
        transport.close()


def close_anyio_subprocess_transport(anyio_proc: Any) -> None:  # type: ignore[explicit-any]
    """Unwrap an anyio ``Process`` to its underlying asyncio process and close its transport."""
    inner = getattr(anyio_proc, "_process", None)
    if inner is None:
        return
    close_subprocess_transport(inner)


# Static-key auth commands are synthesized as ``printf %s <key>`` — decode
# them directly instead of shelling out. On Windows there is no ``sh`` /
# ``printf``, so executing that command fails with WinError 2.
_STATIC_KEY_PREFIX = ("printf", "%s")


def _decode_static_key_command(command: str) -> str | None:
    """Return the literal token when *command* is a synthesized static-key command."""
    try:
        parts = shlex.split(command)
    except ValueError:
        return None
    if len(parts) == 3 and parts[0:2] == list(_STATIC_KEY_PREFIX):
        return parts[2]
    return None


def run_auth_command(command: str) -> str | None:
    """Run a bearer-token auth helper and return its stdout, or ``None``.

    Windows-compatible: a synthesized static-key command (``printf %s
    <key>``) is decoded without a shell (``sh`` does not exist on
    Windows); dynamic commands fall back to ``cmd /c`` on Windows and
    ``sh -c`` elsewhere.

    :param command: Shell command that prints a bearer token.
    :returns: The stripped token, or ``None`` when the command fails or
        prints no token.
    """
    static = _decode_static_key_command(command)
    if static is not None:
        return static
    if os.name == "nt":
        argv = ["cmd", "/c", command]
    else:
        argv = ["sh", "-c", command]
    try:
        result = subprocess.run(
            argv,
            check=False,
            capture_output=True,
            text=True,
        )
    except OSError as exc:
        _logger.warning("auth command %r could not run: %s", command, exc)
        return None
    token = result.stdout.strip()
    if result.returncode != 0 or not token:
        _logger.debug("auth command failed: %s", result.stderr.strip())
        return None
    return token


__all__ = [
    "close_anyio_subprocess_transport",
    "close_subprocess_transport",
    "run_auth_command",
]
