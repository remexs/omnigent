"""REST API routes for projects (``/v1/projects``).

Projects are first-class, owner-private containers that group sessions (see
``designs/PROJECTS_PRD.md``). These endpoints let the web UI create empty
projects, list them, rename them, and delete them. Session membership
(filing a session into a project) is managed on the sessions API via the
conversation store's ``project_id``.

Because projects are owner-private and carry no ACL of their own, every handler
scopes to the requesting user: a caller only ever sees and mutates their own
projects. In single-user mode (no auth provider) the owner is ``None`` and all
projects share that scope.
"""

from __future__ import annotations

import asyncio
import uuid
from typing import Any

from fastapi import APIRouter, Request

from omnigent.entities import Project
from omnigent.errors import ErrorCode, OmnigentError
from omnigent.server.auth import AuthProvider
from omnigent.server.routes._auth_helpers import require_user
from omnigent.server.schemas import (
    AddProjectMemberRequest,
    CreateProjectRequest,
    UpdateProjectRequest,
)
from omnigent.stores.project_store import ProjectStore


def _to_response(project: Project) -> dict[str, Any]:
    """Convert a :class:`Project` entity to a ``ProjectObject`` response dict.

    :param project: The entity to convert.
    :returns: Dict matching the :class:`ProjectObject` shape.
    """
    return {
        "id": project.id,
        "object": "project",
        "name": project.name,
        "kind": project.kind,
        "created_at": project.created_at,
        "updated_at": project.updated_at,
        "config": project.config,
        "members": [
            {"user_id": m.user_id, "role": m.role, "created_at": m.created_at}
            for m in project.members
        ],
    }


def create_projects_router(
    project_store: ProjectStore,
    auth_provider: AuthProvider | None = None,
) -> APIRouter:
    """Build the projects router (``/v1/projects``).

    :param project_store: The store backing project persistence.
    :param auth_provider: Auth provider used to identify the requesting user.
        ``None`` in single-user mode (owner scope is ``None``).
    :returns: A configured :class:`APIRouter`.
    """
    router = APIRouter()

    @router.post("/projects")
    async def create_project(
        request: Request,
        body: CreateProjectRequest,
    ) -> dict[str, Any]:
        """Create a new, empty project owned by the caller.

        :param request: The incoming request, used to identify the user.
        :param body: Project payload (name).
        :returns: The created project as a serialized dict.
        :raises OmnigentError: 401 if unauthenticated in multi-user mode, 409
            if the caller already has a project with this name.
        """
        user_id = require_user(request, auth_provider)
        project = await asyncio.to_thread(
            project_store.create,
            uuid.uuid4().hex,
            body.name,
            user_id,
            body.config,
            kind=body.kind,
        )
        return _to_response(project)

    @router.get("/projects")
    async def list_projects(request: Request) -> dict[str, Any]:
        """List the caller's projects.

        :param request: The incoming request, used to identify the user.
        :returns: ``{"object": "list", "data": [...]}``.
        :raises OmnigentError: 401 if unauthenticated in multi-user mode.
        """
        user_id = require_user(request, auth_provider)
        scope = request.query_params.get("scope", "mine")
        projects = await asyncio.to_thread(
            project_store.list, owner_user_id=user_id, scope=scope
        )
        return {"object": "list", "data": [_to_response(p) for p in projects]}

    @router.get("/projects/{project_id}")
    async def get_project(request: Request, project_id: str) -> dict[str, Any]:
        """Return one of the caller's projects.

        :param request: The incoming request, used to identify the user.
        :param project_id: The project to fetch.
        :returns: The project as a serialized dict.
        :raises OmnigentError: 401 if unauthenticated, 404 if not found / not
            owned by the caller.
        """
        user_id = require_user(request, auth_provider)
        project = await asyncio.to_thread(project_store.get, project_id, owner_user_id=user_id)
        if project is None:
            raise OmnigentError("Project not found", code=ErrorCode.NOT_FOUND)
        return _to_response(project)

    @router.patch("/projects/{project_id}")
    async def update_project(
        request: Request,
        project_id: str,
        body: UpdateProjectRequest,
    ) -> dict[str, Any]:
        """Update one of the caller's projects (e.g. rename).

        :param request: The incoming request, used to identify the user.
        :param project_id: The project to update.
        :param body: Fields to change; ``None`` fields are left unchanged.
        :returns: The updated project as a serialized dict.
        :raises OmnigentError: 401 if unauthenticated, 404 if not found / not
            owned, 409 if the new name collides with another of the caller's
            projects.
        """
        user_id = require_user(request, auth_provider)
        project = await asyncio.to_thread(
            project_store.update,
            project_id,
            owner_user_id=user_id,
            name=body.name,
            config=body.config,
        )
        if project is None:
            raise OmnigentError("Project not found", code=ErrorCode.NOT_FOUND)
        return _to_response(project)

    @router.delete("/projects/{project_id}")
    async def delete_project(request: Request, project_id: str) -> dict[str, Any]:
        """Delete one of the caller's projects.

        Member sessions are not deleted; they are left for the caller to
        unfile (clearing their ``project_id``).

        :param request: The incoming request, used to identify the user.
        :param project_id: The project to delete.
        :returns: ``{"id": ..., "object": "project.deleted", "deleted": True}``.
        :raises OmnigentError: 401 if unauthenticated, 404 if not found / not
            owned by the caller.
        """
        user_id = require_user(request, auth_provider)
        deleted = await asyncio.to_thread(project_store.delete, project_id, owner_user_id=user_id)
        if not deleted:
            raise OmnigentError("Project not found", code=ErrorCode.NOT_FOUND)
        return {"id": project_id, "object": "project.deleted", "deleted": True}

    @router.post("/projects/{project_id}/members")
    async def add_project_member(
        request: Request,
        project_id: str,
        body: AddProjectMemberRequest,
    ) -> dict[str, Any]:
        """Add (or update) a member's role in a team project (owner/admin)."""
        user_id = require_user(request, auth_provider)
        project = await asyncio.to_thread(project_store.get, project_id, owner_user_id=user_id)
        if project is None:
            raise OmnigentError("Project not found", code=ErrorCode.NOT_FOUND)
        if project.kind != "team":
            raise OmnigentError(
                "只有团队项目可以添加成员", code=ErrorCode.INVALID_INPUT
            )
        role = await asyncio.to_thread(
            project_store.member_role, project_id, user_id
        )
        is_owner = project.owner_user_id == user_id
        if not is_owner and role != 2:
            raise OmnigentError(
                "仅项目所有者或管理员可添加成员", code=ErrorCode.FORBIDDEN
            )
        member = await asyncio.to_thread(
            project_store.add_member, project_id, body.user_id, body.role
        )
        return {
            "project_id": project_id,
            "user_id": member.user_id,
            "role": member.role,
        }

    @router.delete("/projects/{project_id}/members/{user_id}")
    async def remove_project_member(
        request: Request,
        project_id: str,
        user_id: str,
    ) -> dict[str, Any]:
        """Remove a member from a team project (owner/admin)."""
        caller = require_user(request, auth_provider)
        project = await asyncio.to_thread(project_store.get, project_id, owner_user_id=caller)
        if project is None:
            raise OmnigentError("Project not found", code=ErrorCode.NOT_FOUND)
        role = await asyncio.to_thread(
            project_store.member_role, project_id, caller
        )
        is_owner = project.owner_user_id == caller
        if not is_owner and role != 2:
            raise OmnigentError(
                "仅项目所有者或管理员可移除成员", code=ErrorCode.FORBIDDEN
            )
        removed = await asyncio.to_thread(
            project_store.remove_member, project_id, user_id
        )
        return {"removed": removed}

    @router.get("/projects/{project_id}/members")
    async def list_project_members(request: Request, project_id: str) -> dict[str, Any]:
        """List a project's members (owner/admin/member/viewer all may read)."""
        user_id = require_user(request, auth_provider)
        project = await asyncio.to_thread(project_store.get, project_id, owner_user_id=user_id)
        if project is None:
            raise OmnigentError("Project not found", code=ErrorCode.NOT_FOUND)
        members = await asyncio.to_thread(project_store.list_members, project_id)
        return {"object": "list", "data": [
            {"user_id": m.user_id, "role": m.role, "created_at": m.created_at}
            for m in members
        ]}

    return router
