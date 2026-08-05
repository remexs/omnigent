"""Skill installation coordination API (``/v1/skills``).

Omnigent deliberately does NOT own skill content — skills live in a
SkillHub registry (e.g. ``@astron-team/skillhub`` at
``http://192.168.10.86:4011``). This router only *coordinates*:

- **list**: what is installed, where (which agent), from which registry.
- **install**: download a skill ZIP from the registry (unauthenticated
  download endpoint) and materialize it into either a specific agent's
  bundle (``~/.omnigent/agents/<agent>/skills/<name>/`` — picked up by the
  harness automatically) or the global skill dir
  (``~/.omnigent/skills/<name>/``).
- **remove**: uninstall a materialized skill and drop its record.

The record lives in ``~/.omnigent/skills.yaml`` (``installed:`` list) —
file-driven like providers, no DB migration needed.
"""

from __future__ import annotations

import logging
import shutil
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Request

from omnigent.config import global_config_path
from omnigent.errors import ErrorCode, OmnigentError
from omnigent.server.auth import AuthProvider
from omnigent.server.routes._auth_helpers import require_user as _require_user

_logger = logging.getLogger(__name__)

# Registry prefix used when no --registry is given.
DEFAULT_SKILL_REGISTRY = "http://192.168.10.86:4011"

# Where installed-skill records live (file-driven, like providers).
SKILLS_FILE_NAME = "skills.yaml"


def _omnigent_dir() -> Path:
    return global_config_path().parent


def _skills_record_path() -> Path:
    return _omnigent_dir() / SKILLS_FILE_NAME


def _load_skills_record() -> dict[str, Any]:
    """Load ``~/.omnigent/skills.yaml``, returning ``{"installed": []}`` shape."""
    path = _skills_record_path()
    if not path.exists():
        return {"installed": []}
    import yaml

    with path.open(encoding="utf-8") as f:
        raw = yaml.safe_load(f) or {}
    if not isinstance(raw, dict) or not isinstance(raw.get("installed"), list):
        return {"installed": []}
    return raw


def _save_skills_record(record: dict[str, Any]) -> None:
    import yaml

    path = _skills_record_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        yaml.safe_dump(record, sort_keys=False, allow_unicode=True),
        encoding="utf-8",
    )


def _agent_bundle_dir(agent: str) -> Path | None:
    """Resolve an agent's bundle root under ``~/.omnigent/agents/``.

    Returns ``None`` when the agent dir doesn't exist on this server.
    """
    candidate = _omnigent_dir() / "agents" / agent
    if candidate.is_dir():
        return candidate
    return None


def _parse_slug(slug: str) -> tuple[str, str]:
    """Split ``namespace/name`` or ``namespace--name`` into (ns, name)."""
    if "/" in slug:
        parts = slug.split("/", 1)
        return parts[0], parts[1]
    if "--" in slug:
        ns, name = slug.split("--", 1)
        return ns, name
    return "global", slug


def _skill_download_url(registry: str, namespace: str, name: str) -> str:
    base = registry.rstrip("/")
    return f"{base}/api/v1/skills/{namespace}/{name}/download"


def _fetch_skill_zip(url: str) -> bytes:
    """Download the skill ZIP from the registry (unauthenticated endpoint)."""
    import httpx

    resp = httpx.get(url, timeout=30.0, follow_redirects=True)
    resp.raise_for_status()
    return resp.content


def _materialize_zip(content: bytes, dest: Path) -> None:
    """Extract a skill ZIP into *dest* (replacing an existing install)."""
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(__import__("io").BytesIO(content)) as zf:
        # Guard against path traversal.
        for member in zf.namelist():
            target = (dest / member).resolve()
            if not target.is_relative_to(dest.resolve()):
                raise OmnigentError(
                    f"skill zip contains unsafe path {member!r}",
                    code=ErrorCode.INVALID_INPUT,
                )
        zf.extractall(dest)
    _logger.info("Materialized skill into %s", dest)


def _skill_frontmatter_from_zip(content: bytes) -> dict[str, object]:
    """Best-effort: read the YAML frontmatter from SKILL.md in the zip."""
    import io

    import yaml

    try:
        with zipfile.ZipFile(io.BytesIO(content)) as zf:
            if "SKILL.md" in zf.namelist():
                text = zf.read("SKILL.md").decode("utf-8", errors="replace")
                if text.startswith("---"):
                    parts = text.split("---", 2)
                    if len(parts) >= 3:
                        parsed = yaml.safe_load(parts[1]) or {}
                        return parsed if isinstance(parsed, dict) else {}
    except Exception:  # noqa: BLE001 - best effort only
        pass
    return {}


def _skill_name_from_zip(content: bytes) -> str | None:
    """Best-effort: read the frontmatter ``name`` from SKILL.md in the zip."""
    frontmatter = _skill_frontmatter_from_zip(content)
    name = frontmatter.get("name")
    return str(name) if name else None


def _serialize_installed(entry: dict[str, Any]) -> dict[str, Any]:
    return {
        "slug": entry.get("slug"),
        "name": entry.get("name"),
        "summary": entry.get("summary"),
        "version": entry.get("version"),
        "agent": entry.get("agent"),
        "registry": entry.get("registry"),
        "installed_at": entry.get("installed_at"),
        "installed_by": entry.get("installed_by"),
        "target": entry.get("target"),
    }


def create_skills_router(*, auth_provider: AuthProvider | None = None) -> APIRouter:
    """Build the router exposing skill install coordination."""
    router = APIRouter()

    @router.get("/skills")
    async def list_skills(request: Request) -> dict:
        """List installed skills (records only; content lives on disk)."""
        _require_user(request, auth_provider)
        record = _load_skills_record()
        return {"skills": [_serialize_installed(e) for e in record["installed"]]}

    @router.get("/skills/registry")
    async def list_registry_skills(request: Request) -> dict:
        """Proxy the SkillHub skill list for the Web UI (CORS-free).

        The browser can't reach the registry directly (no CORS headers), so
        the server relays ``GET /api/v1/skills`` from the configured registry.
        ``registry`` query param overrides the default. Optionally filters by
        ``q`` (substring on slug/displayName/summary).
        """
        _require_user(request, auth_provider)
        registry = (request.query_params.get("registry") or DEFAULT_SKILL_REGISTRY).strip()
        q = (request.query_params.get("q") or "").strip().lower()
        import httpx

        url = f"{registry.rstrip('/')}/api/v1/skills"
        try:
            resp = httpx.get(url, timeout=15.0, follow_redirects=True)
            resp.raise_for_status()
            body = resp.json()
        except Exception as exc:  # noqa: BLE001 - surface registry errors
            raise OmnigentError(
                f"failed to reach SkillHub {registry}: {exc}",
                code=ErrorCode.INTERNAL_ERROR,
            ) from exc
        items = body.get("items", []) if isinstance(body, dict) else []
        out = []
        for it in items:
            slug = it.get("slug", "")
            display = it.get("displayName", "")
            summary = it.get("summary", "")
            if q and q not in slug.lower() and q not in display.lower() and q not in (summary or "").lower():
                continue
            ver = it.get("latestVersion") or {}
            out.append(
                {
                    "slug": slug,
                    "name": display,
                    "summary": summary,
                    "version": ver.get("version") if isinstance(ver, dict) else None,
                    "stats": it.get("stats") or {},
                }
            )
        return {"skills": out, "registry": registry}

    @router.get("/skills/detail")
    async def skill_detail(request: Request) -> dict:
        """Detail of an installed skill (read from the materialized dir).

        ``slug`` and optional ``agent`` identify the installed record; the
        server reads the on-disk ``SKILL.md`` (frontmatter + body) plus the
        file tree so the UI can show the full skill contents.
        """
        _require_user(request, auth_provider)
        slug = (request.query_params.get("slug") or "").strip()
        if not slug:
            raise OmnigentError("slug is required", code=ErrorCode.INVALID_INPUT)
        agent = (request.query_params.get("agent") or "").strip() or None

        record = _load_skills_record()
        entry = next(
            (e for e in record["installed"] if e.get("slug") == slug and e.get("agent") == agent),
            None,
        )
        if entry is None:
            raise OmnigentError(
                f"skill {slug!r} not installed" + (f" for agent {agent!r}" if agent else ""),
                code=ErrorCode.NOT_FOUND,
            )
        target = Path(entry.get("target", ""))
        if not target.is_dir():
            raise OmnigentError(
                f"skill dir missing: {target}",
                code=ErrorCode.NOT_FOUND,
            )

        # SKILL.md frontmatter + body.
        skill_md = target / "SKILL.md"
        frontmatter: dict[str, object] = {}
        body = ""
        if skill_md.exists():
            raw_text = skill_md.read_text(encoding="utf-8", errors="replace")
            if raw_text.startswith("---"):
                parts = raw_text.split("---", 2)
                if len(parts) >= 3:
                    import yaml

                    try:
                        frontmatter = yaml.safe_load(parts[1]) or {}
                    except Exception:  # noqa: BLE001 - best effort
                        frontmatter = {}
                    if isinstance(frontmatter, dict):
                        body = parts[2].strip()
                    else:
                        frontmatter = {}
                        body = raw_text.strip()
            else:
                body = raw_text.strip()

        # File tree (relative paths).
        files: list[str] = []
        for p in sorted(target.rglob("*")):
            if p.is_file():
                files.append(str(p.relative_to(target)))

        return {
            "slug": slug,
            "agent": agent,
            "target": str(target),
            "frontmatter": frontmatter,
            "body": body,
            "files": files,
            "installed_at": entry.get("installed_at"),
        }

    @router.get("/skills/file")
    async def skill_file(request: Request) -> dict:
        """Read a single file from an installed skill (tree browser).

        ``slug`` + optional ``agent`` locate the installed skill; ``path`` is
        the file's path relative to the skill root (e.g. ``scripts/connect.py``).
        """
        _require_user(request, auth_provider)
        slug = (request.query_params.get("slug") or "").strip()
        if not slug:
            raise OmnigentError("slug is required", code=ErrorCode.INVALID_INPUT)
        agent = (request.query_params.get("agent") or "").strip() or None
        rel_path = (request.query_params.get("path") or "").strip()
        if not rel_path:
            raise OmnigentError("path is required", code=ErrorCode.INVALID_INPUT)

        record = _load_skills_record()
        entry = next(
            (e for e in record["installed"] if e.get("slug") == slug and e.get("agent") == agent),
            None,
        )
        if entry is None:
            raise OmnigentError(
                f"skill {slug!r} not installed" + (f" for agent {agent!r}" if agent else ""),
                code=ErrorCode.NOT_FOUND,
            )
        target = Path(entry.get("target", ""))
        if not target.is_dir():
            raise OmnigentError(f"skill dir missing: {target}", code=ErrorCode.NOT_FOUND)

        file_path = (target / rel_path).resolve()
        if not file_path.is_relative_to(target.resolve()):
            raise OmnigentError("path escapes skill root", code=ErrorCode.INVALID_INPUT)
        if not file_path.is_file():
            raise OmnigentError(f"file not found: {rel_path}", code=ErrorCode.NOT_FOUND)

        # Binary guard: only serve text-ish files (or small blobs as base64).
        data = file_path.read_bytes()
        try:
            text = data.decode("utf-8")
            is_binary = False
        except UnicodeDecodeError:
            text = ""
            is_binary = True

        size = len(data)
        return {
            "path": rel_path,
            "name": file_path.name,
            "content": text[:200_000],
            "size": size,
            "binary": is_binary,
        }

    @router.get("/skills/registry/{namespace}/{name}")
    async def registry_skill_detail(namespace: str, name: str, request: Request) -> dict:
        """Proxy a single SkillHub skill's detail (CORS-free)."""
        _require_user(request, auth_provider)
        registry = (request.query_params.get("registry") or DEFAULT_SKILL_REGISTRY).strip()
        import httpx

        url = f"{registry.rstrip('/')}/api/v1/skills/{namespace}/{name}"
        try:
            resp = httpx.get(url, timeout=15.0, follow_redirects=True)
            resp.raise_for_status()
            body = resp.json()
        except Exception as exc:  # noqa: BLE001 - surface registry errors
            raise OmnigentError(
                f"failed to reach SkillHub {registry}: {exc}",
                code=ErrorCode.INTERNAL_ERROR,
            ) from exc
        data = body.get("data", body) if isinstance(body, dict) else {}
        skill = data.get("skill", data) if isinstance(data, dict) else data
        latest = data.get("latestVersion") if isinstance(data, dict) else None
        return {
            "slug": skill.get("slug") if isinstance(skill, dict) else None,
            "name": skill.get("displayName") if isinstance(skill, dict) else None,
            "summary": skill.get("summary") if isinstance(skill, dict) else None,
            "version": latest.get("version") if isinstance(latest, dict) else None,
            "changelog": latest.get("changelog") if isinstance(latest, dict) else None,
        }

    @router.post("/skills/install")
    async def install_skill(request: Request) -> dict:
        """Install a skill from the registry into an agent bundle or global dir."""
        _require_user(request, auth_provider)
        body = await request.json()
        slug = str(body.get("slug") or "").strip()
        if not slug:
            raise OmnigentError(
                "slug is required (e.g. cwr/ssh-server-ops)",
                code=ErrorCode.INVALID_INPUT,
            )
        agent = (body.get("agent") or "").strip() or None
        registry = (body.get("registry") or DEFAULT_SKILL_REGISTRY).strip()

        namespace, name = _parse_slug(slug)

        # Resolve install target.
        if agent:
            bundle = _agent_bundle_dir(agent)
            if bundle is None:
                raise OmnigentError(
                    f"agent {agent!r} not found under ~/.omnigent/agents/",
                    code=ErrorCode.NOT_FOUND,
                )
            target = bundle / "skills"
        else:
            target = _omnigent_dir() / "skills"

        # Download + materialize.
        url = _skill_download_url(registry, namespace, name)
        _logger.info("Downloading skill from %s", url)
        try:
            content = _fetch_skill_zip(url)
        except Exception as exc:  # noqa: BLE001 - surface registry errors
            raise OmnigentError(
                f"failed to download skill {slug!r} from {registry}: {exc}",
                code=ErrorCode.INTERNAL_ERROR,
            ) from exc

        skill_name = _skill_name_from_zip(content) or name
        dest = target / skill_name
        _materialize_zip(content, dest)

        # Extract a one-line summary from SKILL.md frontmatter (description).
        frontmatter = _skill_frontmatter_from_zip(content)
        summary = frontmatter.get("description")
        if not summary and dest.exists():
            md = dest / "SKILL.md"
            if md.exists():
                import yaml

                raw_text = md.read_text(encoding="utf-8", errors="replace")
                if raw_text.startswith("---"):
                    parts = raw_text.split("---", 2)
                    if len(parts) >= 3:
                        parsed = yaml.safe_load(parts[1]) or {}
                        if isinstance(parsed, dict):
                            summary = parsed.get("description")

        # Record.
        record = _load_skills_record()
        record["installed"] = [
            e
            for e in record["installed"]
            if not (e.get("slug") == slug and e.get("agent") == agent)
        ]
        entry = {
            "slug": slug,
            "name": skill_name,
            "summary": str(summary) if summary else None,
            "version": body.get("version") or "latest",
            "agent": agent,
            "registry": registry,
            "target": str(dest),
            "installed_at": datetime.now(timezone.utc).isoformat(),
            "installed_by": getattr(request.state, "user_id", None),
        }
        record["installed"].append(entry)
        _save_skills_record(record)

        return {"installed": _serialize_installed(entry), "target": str(dest)}

    @router.post("/skills/remove")
    async def remove_skill(request: Request) -> dict:
        """Uninstall a skill (delete materialized dir + drop record)."""
        _require_user(request, auth_provider)
        body = await request.json()
        slug = str(body.get("slug") or "").strip()
        if not slug:
            raise OmnigentError("slug is required", code=ErrorCode.INVALID_INPUT)
        agent = (body.get("agent") or "").strip() or None

        record = _load_skills_record()
        kept: list[dict[str, Any]] = []
        removed_targets: list[str] = []
        for e in record["installed"]:
            if e.get("slug") == slug and e.get("agent") == agent:
                tgt = e.get("target")
                if tgt:
                    removed_targets.append(tgt)
                continue
            kept.append(e)
        record["installed"] = kept
        _save_skills_record(record)

        for tgt in removed_targets:
            p = Path(tgt)
            if p.exists():
                shutil.rmtree(p)
        return {"removed": slug, "agent": agent}

    return router
