"""Model provider management API (``/v1/providers``).

Lets the Web UI read, create, update, and delete entries in the
``providers:`` block of ``~/.omnigent/config.yaml`` — the visual
counterpart to hand-editing YAML. Providers here power the model
selection for pi / goose / codex / claude-sdk harnesses (see
``omnigent/onboarding/provider_config.py``).

The secret (``api_key``) is stored as an ``env:`` / ``keychain:``
reference or inline value exactly as the YAML would; responses never
echo raw secret values back (the resolved credential readout lives in
the existing ``/model`` surface).
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Request

from omnigent.config import global_config_path, load_global_config
from omnigent.errors import ErrorCode, OmnigentError
from omnigent.onboarding.provider_config import (
    ProviderKind,
    load_providers,
)
from omnigent.server.auth import AuthProvider
from omnigent.server.routes._auth_helpers import require_user as _require_user

_logger = logging.getLogger(__name__)

# Kinds creatable from the UI. subscription/databricks/cli-config need
# CLI-side login flows and are out of scope for a form.
EDITABLE_KINDS: tuple[ProviderKind, ...] = ("key", "gateway", "local")


def _family_block(body: dict[str, Any]) -> dict[str, Any]:
    """Build a single-family block from the request body (or None)."""
    base_url = body.get("base_url")
    api_key = body.get("api_key")
    model = body.get("model")
    wire_api = body.get("wire_api")
    block: dict[str, Any] = {}
    if base_url:
        block["base_url"] = str(base_url)
    if api_key:
        # Support both literal keys and ``env:VAR`` / ``keychain:name`` refs.
        block["api_key"] = str(api_key)
    if model:
        block["models"] = {"default": str(model)}
    if wire_api:
        block["wire_api"] = str(wire_api)
    return block


def _serialize_provider(entry: Any) -> dict[str, Any]:
    """Serialize a parsed ProviderEntry for the API (secrets redacted)."""
    families: dict[str, dict[str, Any]] = {}
    for fam, fc in entry.families.items():
        f = {
            "base_url": fc.base_url,
            "api_key_ref": fc.api_key_ref,
            "models": dict(fc.models),
            "wire_api": fc.wire_api,
        }
        families[fam] = f
    return {
        "name": entry.name,
        "kind": entry.kind,
        "families": families,
        "cli": entry.cli,
        "profile": entry.profile,
        "model_provider": entry.model_provider,
        "default_families": sorted(entry.default_families),
    }


def create_providers_router(*, auth_provider: AuthProvider | None = None) -> APIRouter:
    """Build the router exposing provider CRUD."""
    router = APIRouter()

    @router.get("/providers")
    async def list_providers(request: Request) -> dict:
        """List configured providers (secrets redacted)."""
        _require_user(request, auth_provider)
        cfg = load_global_config()
        entries = load_providers(cfg)
        return {"providers": [_serialize_provider(e) for e in entries.values()]}

    @router.post("/providers")
    async def create_provider(request: Request) -> dict:
        """Create a provider in ``~/.omnigent/config.yaml``."""
        _require_user(request, auth_provider)
        body = await request.json()
        name = str(body.get("name", "")).strip()
        kind = body.get("kind")
        if not name:
            raise OmnigentError("provider name required", code=ErrorCode.INVALID_INPUT)
        if kind not in EDITABLE_KINDS:
            raise OmnigentError(
                f"kind must be one of {', '.join(EDITABLE_KINDS)}",
                code=ErrorCode.INVALID_INPUT,
            )

        cfg = load_global_config()
        providers = cfg.setdefault("providers", {})
        if name in providers:
            raise OmnigentError(
                f"provider {name!r} already exists",
                code=ErrorCode.INVALID_INPUT,
            )

        family = body.get("family", "openai")
        block: dict[str, Any] = {"kind": kind}
        fam_block = _family_block(body)
        if not fam_block:
            raise OmnigentError(
                "at least base_url or api_key required",
                code=ErrorCode.INVALID_INPUT,
            )
        block[family] = fam_block
        if body.get("default"):
            block["default"] = True
        providers[name] = block

        _write_config(cfg)
        return {"created": name}

    @router.put("/providers/{name}")
    async def update_provider(name: str, request: Request) -> dict:
        """Update an existing provider entry."""
        _require_user(request, auth_provider)
        body = await request.json()
        cfg = load_global_config()
        providers = cfg.setdefault("providers", {})
        if name not in providers:
            raise OmnigentError(
                f"provider {name!r} not found",
                code=ErrorCode.NOT_FOUND,
            )
        existing = providers[name]
        if not isinstance(existing, dict):
            raise OmnigentError("malformed provider", code=ErrorCode.INVALID_INPUT)

        family = body.get("family", "openai")
        fam_block = _family_block(body)
        if fam_block:
            existing[family] = fam_block
        if "default" in body:
            if body["default"]:
                existing["default"] = True
            else:
                existing.pop("default", None)
        if body.get("kind") in EDITABLE_KINDS:
            existing["kind"] = body["kind"]
        _write_config(cfg)
        return {"updated": name}

    @router.delete("/providers/{name}")
    async def delete_provider(name: str, request: Request) -> dict:
        """Delete a provider entry."""
        _require_user(request, auth_provider)
        cfg = load_global_config()
        providers = cfg.get("providers")
        if not isinstance(providers, dict) or name not in providers:
            raise OmnigentError(
                f"provider {name!r} not found",
                code=ErrorCode.NOT_FOUND,
            )
        del providers[name]
        _write_config(cfg)
        return {"deleted": name}

    return router


def _write_config(cfg: dict[str, Any]) -> None:
    """Persist the config mapping back to ``~/.omnigent/config.yaml``."""
    import yaml

    path = global_config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    # Preserve key order; safe_dump keeps existing anchors readable.
    path.write_text(
        yaml.safe_dump(cfg, sort_keys=False, allow_unicode=True),
        encoding="utf-8",
    )
    _logger.debug("Wrote providers config to %s", path)
