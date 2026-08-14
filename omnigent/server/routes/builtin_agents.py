"""Read-only route for discovering built-in agents (``GET /v1/agents``).

Built-in agents are the long-lived, shared agents the server provides
out of the box — the seeded ``claude-native-ui`` agent plus anything
registered at startup with ``omnigent server --agent``. They are the
``session_id IS NULL`` rows in ``agent_store``; ``agent_store.list()``
already filters to exactly these. Session-scoped agents (created via
multipart ``POST /v1/sessions``) belong to one conversation and are read
through ``GET /v1/sessions/{id}/agent`` — never here.

The Web UI's new-session picker calls this to discover bindable
built-ins, then creates a session with
``POST /v1/sessions {agent_id, host_id, workspace}``. See
``designs/BUILTIN_AGENTS.md``.

This is the read-only successor to the removed ``GET /api/agents`` list:
there is intentionally no create/update/delete — agent writes happen
through session creation.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from fastapi import APIRouter, Query, Request

from omnigent.db.utils import builtin_agent_id
from omnigent.entities import Agent
from omnigent.runtime.agent_cache import AgentCache
from omnigent.server.auth import AuthProvider
from omnigent.server.routes._auth_helpers import require_user as _require_user
from omnigent.server.schemas import AgentObject, MCPServerSummary, PaginatedList, SkillSummary
from omnigent.stores import AgentStore

_logger = logging.getLogger(__name__)


def _to_agent_object(agent: Agent, agent_cache: AgentCache) -> AgentObject:
    """
    Convert a runtime Agent entity to an API-layer AgentObject.

    Loads the spec from cache to populate ``mcp_servers``,
    ``skills``, and (when the stored row has none) the
    ``description``; on any load failure those fall back to empty /
    the stored value rather than failing the whole list — one
    unreadable bundle must not break discovery.

    :param agent: The runtime agent entity, e.g. the seeded
        ``claude-native-ui`` agent.
    :param agent_cache: Cache used to load the agent spec.
    :returns: An :class:`AgentObject` for the API response.
    """
    mcp_servers: list[MCPServerSummary] = []
    skills: list[SkillSummary] = []
    terminals: list[str] = []
    harness: str | None = None
    # Prefer the stored entity's description; fall back to the spec's
    # top-level description when the stored value is unset (single-file
    # YAML agents don't persist it at registration today). Lets the
    # new-session picker show a hover description without a migration.
    description: str | None = agent.description
    try:
        # Built-ins are operator-authored template agents
        # (session_id is None), so ${VAR} expansion against the server
        # env is allowed here; a tenant session-scoped agent would not
        # expand.
        loaded = agent_cache.load(
            agent.id, agent.bundle_location, expand_env=agent.session_id is None
        )
        if description is None:
            description = loaded.spec.description
        # Declared terminal names, in spec order (mirrors the
        # session-agent endpoint so both report it consistently).
        terminals = list(loaded.spec.terminals or {})
        # Bundled skills only — host-discovered skills are runner-owned
        # and unknowable here (no session, no runner). The new-session
        # composer uses this list for its "/" menu.
        skills = [SkillSummary(name=s.name, description=s.description) for s in loaded.spec.skills]
        mcp_servers = [
            MCPServerSummary(
                name=srv.name,
                transport=srv.transport,
                description=srv.description,
                url=srv.url,
                headers=dict.fromkeys(srv.headers, "[REDACTED]") if srv.headers else {},
                command=srv.command,
                args=srv.args,
            )
            for srv in loaded.spec.mcp_servers
        ]
        # Kind for the Add Agent picker (Codex vs Claude). Stays None
        # when the bundle can't be loaded (the except below).
        harness = loaded.spec.executor.harness_kind
        # Management-view fields: orchestrator shape + raw config.
        spawn = bool(getattr(loaded.spec, "spawn", False))
        tools_obj = getattr(loaded.spec, "tools", None)
        sub_agents = list(getattr(tools_obj, "agents", None) or [])
        executor_harness = harness  # harness_kind is the canonical executor id
        config_yaml = _read_bundle_config(agent_cache, agent.id, agent.bundle_location)
    except Exception:
        _logger.debug(
            "Failed to load spec for agent %s; mcp_servers/skills will be empty",
            agent.id,
            exc_info=True,
        )
        spawn = False
        sub_agents = []
        executor_harness = None
        config_yaml = None
    return AgentObject(
        id=agent.id,
        name=agent.name,
        version=agent.version,
        owner_user_id=agent.owner_user_id,
        description=description,
        created_at=agent.created_at,
        updated_at=agent.updated_at,
        harness=harness,
        mcp_servers=mcp_servers,
        mcp_servers_editable=False,
        skills=skills,
        terminals=terminals,
        # Seeded built-ins use a deterministic, name-derived id; an
        # operator/user-registered template (e.g. ``--agent``) uses a
        # random id. The picker protects the former from being shadowed
        # by a same-named ``omnigent run`` upload, but lets a newer
        # upload supersede the latter.
        builtin=agent.session_id is None and agent.id == builtin_agent_id(agent.name),
        spawn=spawn,
        sub_agents=sub_agents,
        executor_harness=executor_harness,
        config_yaml=config_yaml,
        is_orchestrator=bool(spawn or sub_agents),
    )


def _read_bundle_config(
    agent_cache: AgentCache,
    agent_id: str,
    bundle_location: str,
) -> str | None:
    """Read the raw ``config.yaml`` from an agent's extracted bundle.

    Native built-in bundles carry their spec under the agent's name
    (``<name>.yaml`` — the spec filename) rather than ``config.yaml``;
    fall back to any ``*.yaml`` in the bundle root so their config is
    visible too.

    :param agent_cache: The agent cache (holds the extracted workdir).
    :param agent_id: Agent identifier.
    :param bundle_location: Artifact store key.
    :returns: The raw config text, or ``None`` if unavailable.
    """
    try:
        loaded = agent_cache.load(agent_id, bundle_location, expand_env=False)
        cfg = loaded.workdir / "config.yaml"
        if cfg.is_file():
            return cfg.read_text(encoding="utf-8")
        for candidate in sorted(loaded.workdir.glob("*.yaml")):
            if candidate.is_file():
                return candidate.read_text(encoding="utf-8")
        return None
    except Exception:  # noqa: BLE001 — read failure degrades to None
        return None


def _replace_agent_config(
    agent_store: Any,
    agent_cache: AgentCache,
    artifact_store: Any,
    agent_id: str,
    new_config: str,
) -> None:
    """Replace an agent's ``config.yaml`` and re-register the bundle.

    Reads the current bundle, swaps ``config.yaml``, repacks a fresh
    tarball, and updates the store + cache so the change takes effect
    immediately (and survives restart, since the artifact is persisted).

    :param agent_store: The agent store.
    :param agent_cache: The agent cache.
    :param artifact_store: The artifact store holding bundles.
    :param agent_id: Agent identifier.
    :param new_config: Replacement ``config.yaml`` text.
    :raises ValueError: If the new config fails to parse.
    """
    import gzip
    import hashlib
    import io
    import shutil
    import tarfile
    import tempfile
    from pathlib import Path

    from omnigent.spec import load as load_spec_dir

    agent = agent_store.get(agent_id)
    if agent is None:
        raise ValueError(f"Agent not found: {agent_id!r}")
    loaded = agent_cache.load(agent.id, agent.bundle_location, expand_env=False)
    workdir = loaded.workdir

    # Validate the new config by writing it into a staging copy.
    with tempfile.TemporaryDirectory() as tmpdir:
        staging = Path(tmpdir) / "bundle"
        shutil.copytree(workdir, staging)
        (staging / "config.yaml").write_text(new_config, encoding="utf-8")
        try:
            load_spec_dir(staging)
        except Exception as exc:
            raise ValueError(f"Invalid config.yaml: {exc}") from exc

        buf = io.BytesIO()
        with (
            gzip.GzipFile(fileobj=buf, mode="wb", mtime=0) as gz,
            tarfile.open(fileobj=gz, mode="w") as tar,
        ):
            tar.add(str(staging), arcname=".")
        bundle_bytes = buf.getvalue()

    bundle_hash = hashlib.sha256(bundle_bytes).hexdigest()
    new_loc = f"{agent.id}/{bundle_hash}"
    artifact_store.put(new_loc, bundle_bytes)
    agent_store.update(agent.id, bundle_location=new_loc)
    agent_cache.replace(agent.id, new_loc, bundle_bytes, expand_env=True)


def _owner_from_agent_name(name: str) -> str | None:
    """Derive the owning member from a member-agent name.

    Member agent specs are named ``<member>-agent`` (e.g.
    ``zhangsan-agent``); the owner is the prefix. Built-ins / shared
    agents (``pi-native-ui`` etc.) have no owner.
    """
    if name.endswith("-agent") and "-" in name:
        return name[: -len("-agent")]
    return None


def create_builtin_agents_router(
    agent_store: AgentStore,
    agent_cache: AgentCache,
    artifact_store: Any,
    *,
    auth_provider: AuthProvider | None = None,
) -> APIRouter:
    """Build the router for ``GET /v1/agents`` (built-in discovery).

    Mounted with ``prefix="/v1"`` so the final path is ``/v1/agents``.

    :param agent_store: Store whose ``list()`` returns only built-in
        (``session_id IS NULL``) agents.
    :param agent_cache: Cache for loading specs (populates
        ``mcp_servers`` on each agent).
    :param auth_provider: Optional auth provider; when set, the caller
        must be authenticated.
    :returns: A FastAPI router exposing the read-only list.
    """
    router = APIRouter()

    @router.get("/agents")
    async def list_builtin_agents(
        request: Request,
        limit: int = Query(default=20, ge=1, le=1000),
        after: str | None = Query(default=None),
        before: str | None = Query(default=None),
        order: str = Query(default="desc", pattern="^(asc|desc)$"),
    ) -> PaginatedList:
        """List built-in agents with cursor-based pagination.

        Returns only built-in agents — ``agent_store.list()`` filters
        ``session_id IS NULL`` — so session-scoped agents never appear.

        :param request: The incoming FastAPI request (for auth).
        :param limit: Maximum number of agents to return (1-1000).
        :param after: Cursor — return agents after this id.
        :param before: Cursor — return agents before this id.
        :param order: Sort order, ``"asc"`` or ``"desc"``.
        :returns: A :class:`PaginatedList` of built-in agents.
        """
        _require_user(request, auth_provider)
        page = agent_store.list(limit=limit, after=after, before=before, order=order)
        return PaginatedList(
            data=[_to_agent_object(a, agent_cache) for a in page.data],
            first_id=page.first_id,
            last_id=page.last_id,
            has_more=page.has_more,
        )

    @router.get("/agents/{agent_id}")
    async def get_agent_detail(
        agent_id: str,
        request: Request,
    ) -> AgentObject:
        """Fetch a single built-in agent with its spec-derived fields.

        Loads the agent from the store and resolves its spec (harness,
        spawn flag, declared sub-agents, and raw config) so the management
        UI can render an editable view.

        :param agent_id: Durable agent identifier (hex).
        :param request: The incoming FastAPI request (for auth).
        :returns: The :class:`AgentObject` for the agent.
        """
        _require_user(request, auth_provider)
        agent = await asyncio.to_thread(agent_store.get, agent_id)
        if agent is None:
            from omnigent.errors import ErrorCode, OmnigentError

            raise OmnigentError(
                f"Agent not found: {agent_id!r}",
                code=ErrorCode.NOT_FOUND,
            )
        return _to_agent_object(agent, agent_cache)

    @router.delete("/agents/{agent_id}")
    async def delete_builtin_agent(
        agent_id: str,
        request: Request,
    ) -> dict:
        """Delete a built-in agent (admin only).

        Removes the agent row and its stored bundle. Built-in agents
        seeded by the server (deterministic id) cannot be deleted — they
        re-register on next boot; only operator-registered agents
        (``--agent``) are removable.

        :param agent_id: Durable agent identifier (hex).
        :param request: The incoming FastAPI request (for auth).
        :returns: ``{"deleted": true}`` on success.
        """
        _require_user(request, auth_provider)
        from omnigent.errors import ErrorCode, OmnigentError

        agent = await asyncio.to_thread(agent_store.get, agent_id)
        if agent is None:
            raise OmnigentError(
                f"Agent not found: {agent_id!r}",
                code=ErrorCode.NOT_FOUND,
            )
        # Refuse to delete server-seeded built-ins: they re-register on
        # next boot and deleting them would only confuse the UI.
        if agent.id == builtin_agent_id(agent.name):
            raise OmnigentError(
                f"Agent {agent.name!r} is a server-seeded built-in and cannot be deleted.",
                code=ErrorCode.INVALID_INPUT,
            )
        await asyncio.to_thread(agent_store.delete, agent_id)
        return {"deleted": True}

    @router.put("/agents/{agent_id}/config")
    async def update_agent_config(
        agent_id: str,
        request: Request,
    ) -> AgentObject:
        """Replace an agent's config.yaml from the management UI.

        Reads the new YAML body, repackages the agent bundle with the
        updated config, and re-registers it (bumping version). Only
        operator-registered (non-seeded) agents accept edits; seeded
        built-ins re-register on next boot and would discard changes.

        :param agent_id: Durable agent identifier (hex).
        :param request: The incoming FastAPI request (body = YAML).
        :returns: The updated :class:`AgentObject`.
        """
        _require_user(request, auth_provider)
        from omnigent.errors import ErrorCode, OmnigentError

        agent = await asyncio.to_thread(agent_store.get, agent_id)
        if agent is None:
            raise OmnigentError(
                f"Agent not found: {agent_id!r}",
                code=ErrorCode.NOT_FOUND,
            )
        if agent.id == builtin_agent_id(agent.name):
            raise OmnigentError(
                f"Agent {agent.name!r} is server-seeded; edit its source bundle instead.",
                code=ErrorCode.INVALID_INPUT,
            )
        raw = (await request.body()).decode("utf-8").strip()
        if not raw:
            raise OmnigentError("Empty config body", code=ErrorCode.INVALID_INPUT)
        try:
            await asyncio.to_thread(
                _replace_agent_config,
                agent_store,
                agent_cache,
                artifact_store,
                agent_id,
                raw,
            )
        except ValueError as exc:
            raise OmnigentError(str(exc), code=ErrorCode.INVALID_INPUT) from exc
        updated = await asyncio.to_thread(agent_store.get, agent_id)
        if updated is None:
            raise OmnigentError("Agent vanished after update", code=ErrorCode.NOT_FOUND)
        return _to_agent_object(updated, agent_cache)

    @router.post("/agents")
    async def register_agent(request: Request) -> dict:
        """Register a built-in agent from config YAML (+ optional sub-agents).

        The request body is either:
        - ``application/yaml``: a complete agent ``config.yaml``.
        - ``application/json``: ``{"config_yaml": "...", "sub_agents":
          {"<name>": "...config yaml..."}}``
          so the workflow editor can register an orchestrator together with
          its sub-agent definitions in one call.

        The config(s) are materialized into a bundle (``config.yaml`` +
        ``agents/<name>/config.yaml``), validated, and registered as a
        built-in agent so any host can launch it without a restart.

        :param request: The incoming FastAPI request.
        :returns: ``{"agent_id": ..., "name": ...}`` on success.
        """
        _require_user(request, auth_provider)
        from omnigent.errors import ErrorCode, OmnigentError
        from omnigent.spec import load as load_spec_dir

        content_type = request.headers.get("content-type", "").split(";", 1)[0].lower()
        import tempfile
        from pathlib import Path

        if content_type == "application/json":
            payload = await request.json()
            raw = str(payload.get("config_yaml", "")).strip()
            sub_agent_configs: dict[str, str] = {}
            for name, cfg in (payload.get("sub_agents") or {}).items():
                if isinstance(cfg, str) and cfg.strip():
                    sub_agent_configs[str(name)] = cfg.strip()
        else:
            raw = (await request.body()).decode("utf-8").strip()
            sub_agent_configs = {}
        if not raw:
            raise OmnigentError("Empty config body", code=ErrorCode.INVALID_INPUT)

        with tempfile.TemporaryDirectory() as tmpdir:
            bundle_dir = Path(tmpdir) / "bundle"
            bundle_dir.mkdir()
            (bundle_dir / "config.yaml").write_text(raw, encoding="utf-8")
            for sub_name, sub_cfg in sub_agent_configs.items():
                sub_dir = bundle_dir / "agents" / sub_name
                sub_dir.mkdir(parents=True, exist_ok=True)
                (sub_dir / "config.yaml").write_text(sub_cfg, encoding="utf-8")
            try:
                spec = load_spec_dir(bundle_dir)
            except Exception as exc:
                raise OmnigentError(
                    f"Invalid config.yaml: {exc}", code=ErrorCode.INVALID_INPUT
                ) from exc
            if not spec.name:
                raise OmnigentError(
                    "config.yaml must declare a name", code=ErrorCode.INVALID_INPUT
                )
            # Repack into a bundle tarball.
            import gzip
            import hashlib
            import io
            import tarfile

            buf = io.BytesIO()
            with (
                gzip.GzipFile(fileobj=buf, mode="wb", mtime=0) as gz,
                tarfile.open(fileobj=gz, mode="w") as tar,
            ):
                tar.add(str(bundle_dir), arcname=".")
            bundle_bytes = buf.getvalue()

        bundle_hash = hashlib.sha256(bundle_bytes).hexdigest()
        existing = agent_store.get_by_name(spec.name)
        if existing is not None:
            new_loc = f"{existing.id}/{bundle_hash}"
            artifact_store.put(new_loc, bundle_bytes)
            agent_store.update(existing.id, bundle_location=new_loc)
            agent_cache.replace(existing.id, new_loc, bundle_bytes, expand_env=True)
            return {"agent_id": existing.id, "name": spec.name, "updated": True}

        from omnigent.db.utils import generate_agent_id

        agent_id = generate_agent_id()
        loc = f"{agent_id}/{bundle_hash}"
        artifact_store.put(loc, bundle_bytes)
        agent_store.create(
            agent_id=agent_id,
            name=spec.name,
            bundle_location=loc,
            description=spec.description,
            owner_user_id=_owner_from_agent_name(spec.name),
        )
        return {"agent_id": agent_id, "name": spec.name, "updated": False}

    return router
