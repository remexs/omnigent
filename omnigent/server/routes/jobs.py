"""Business job management API (``/v1/jobs``).

Outer collaboration layer: create / assign / claim / evaluate business jobs
that map to inner session executions. The job tree drives multi-role,
multi-user coordination — a project manager assigns jobs to executors, who
claim them (spawning a session on their own host), and reviewers evaluate the
produced artifacts to approve the next stage or send the job back for a
rework (round + 1).
"""

from __future__ import annotations

import secrets
from typing import Any

from fastapi import APIRouter, Request

from omnigent.db.utils import now_epoch
from omnigent.entities import Job, JobArtifact, JobEvaluation
from omnigent.errors import ErrorCode, OmnigentError
from omnigent.server.auth import AuthProvider
from omnigent.server.routes._auth_helpers import require_user as _require_user
from omnigent.stores.job_store import JobStore


def _serialize_job(t: Job) -> dict[str, Any]:
    return {
        "id": t.id,
        "title": t.title,
        "state": t.state,
        "round": t.round,
        "parent_job_id": t.parent_job_id,
        "root_job_id": t.root_job_id,
        "description": t.description,
        "assignee_user_id": t.assignee_user_id,
        "created_by_user_id": t.created_by_user_id,
        "agent_name": t.agent_name,
        "depends_on": t.depends_on,
        "session_id": t.session_id,
        "created_at": t.created_at,
        "updated_at": t.updated_at,
        "artifacts": [
            {
                "id": a.id,
                "artifact_type": a.artifact_type,
                "ref": a.ref,
                "summary": a.summary,
                "created_at": a.created_at,
            }
            for a in t.artifacts
        ],
        "evaluations": [
            {
                "id": e.id,
                "action": e.action,
                "evaluator_user_id": e.evaluator_user_id,
                "comment": e.comment,
                "created_at": e.created_at,
            }
            for e in t.evaluations
        ],
        "children": [_serialize_job(c) for c in t.children],
    }


def create_jobs_router(*, auth_provider: AuthProvider | None = None) -> APIRouter:
    """Build the router exposing business-job management."""
    router = APIRouter()

    def _store(request: Request) -> JobStore:
        store = getattr(request.app.state, "job_store", None)
        if store is None:
            raise OmnigentError(
                "job store not available on this server",
                code=ErrorCode.INTERNAL_ERROR,
            )
        return store

    @router.get("/jobs")
    async def list_jobs(request: Request) -> dict:
        """List job roots (or jobs for a user)."""
        _require_user(request, auth_provider)
        store = _store(request)
        user_id = getattr(request.state, "user_id", None)
        q = request.query_params
        scope = q.get("scope", "roots")  # roots | assigned | created
        if scope == "assigned" and user_id:
            jobs = store.list_by_assignee(user_id)
        elif scope == "created" and user_id:
            jobs = store.list_by_creator(user_id)
        else:
            jobs = store.list_roots()
        return {"jobs": [_serialize_job(t) for t in jobs]}

    @router.get("/jobs/stats")
    async def job_stats(request: Request) -> dict:
        """Aggregate job counts for management (job-volume statistics)."""
        _require_user(request, auth_provider)
        store = _store(request)
        roots = store.list_roots()
        total = 0
        by_state: dict[str, int] = {}
        total_rounds = 0
        total_rejects = 0

        def walk(jobs: list[Job]) -> None:
            nonlocal total, total_rounds, total_rejects
            for t in jobs:
                total += 1
                total_rounds += t.round
                by_state[t.state] = by_state.get(t.state, 0) + 1
                for e in t.evaluations:
                    if e.action == "reject":
                        total_rejects += 1
                walk(t.children)

        for root in roots:
            walk([root])
        return {
            "total_jobs": total,
            "by_state": by_state,
            "total_rounds": total_rounds,
            "total_rejects": total_rejects,
            "root_count": len(roots),
        }

    @router.get("/jobs/tree/{root_job_id}")
    async def get_job_tree(root_job_id: str, request: Request) -> dict:
        """Return the full job tree rooted at *root_job_id*."""
        _require_user(request, auth_provider)
        store = _store(request)
        tree = store.get_tree(root_job_id)
        return {"jobs": [_serialize_job(t) for t in tree]}

    @router.get("/jobs/{job_id}")
    async def get_job(job_id: str, request: Request) -> dict:
        """Return a single job with artifacts + evaluations."""
        _require_user(request, auth_provider)
        store = _store(request)
        job = store.get(job_id)
        if job is None:
            raise OmnigentError(f"job {job_id!r} not found", code=ErrorCode.NOT_FOUND)
        return {"job": _serialize_job(job)}

    @router.post("/jobs")
    async def create_job(request: Request) -> dict:
        """Create a business job (root or child)."""
        user = _require_user(request, auth_provider)
        body = await request.json()
        title = str(body.get("title") or "").strip()
        if not title:
            raise OmnigentError("title is required", code=ErrorCode.INVALID_INPUT)
        parent_job_id = body.get("parent_job_id") or None
        root_job_id = body.get("root_job_id") or None
        store = _store(request)
        # If a child and no explicit root, resolve from the parent.
        if parent_job_id and not root_job_id:
            parent = store.get(parent_job_id)
            if parent is None:
                raise OmnigentError(
                    f"parent job {parent_job_id!r} not found", code=ErrorCode.NOT_FOUND
                )
            root_job_id = parent.root_job_id or parent.id
        if not root_job_id:
            root_job_id = None  # this is itself a root
        job_id = secrets.token_hex(16)
        job = store.create(
            job_id,
            title,
            str(user) if user else None,
            parent_job_id=parent_job_id,
            root_job_id=root_job_id,
            description=body.get("description") or None,
            assignee_user_id=body.get("assignee_user_id") or None,
            agent_name=body.get("agent_name") or None,
            depends_on=body.get("depends_on") or None,
            state=body.get("state") or "todo",
        )
        return {"job": _serialize_job(job)}

    @router.post("/jobs/{job_id}/claim")
    async def claim_job(job_id: str, request: Request) -> dict:
        """Claim a job: set assignee + move to in_progress."""
        user = _require_user(request, auth_provider)
        store = _store(request)
        job = store.get(job_id)
        if job is None:
            raise OmnigentError(f"job {job_id!r} not found", code=ErrorCode.NOT_FOUND)
        updated = store.update(
            job_id,
            state="in_progress",
            assignee_user_id=str(user) if user else None,
        )
        return {"job": _serialize_job(updated) if updated else {}}

    @router.post("/jobs/{job_id}/complete")
    async def complete_job(job_id: str, request: Request) -> dict:
        """Mark a job complete with an optional artifact, moving to pending_review."""
        _require_user(request, auth_provider)
        body = await request.json()
        store = _store(request)
        job = store.get(job_id)
        if job is None:
            raise OmnigentError(f"job {job_id!r} not found", code=ErrorCode.NOT_FOUND)
        artifact = body.get("artifact") or {}
        a_type = artifact.get("artifact_type") or "none"
        if a_type in ("file", "message"):
            store.add_artifact(
                secrets.token_hex(16),
                job_id,
                a_type,
                ref=artifact.get("ref") or None,
                summary=artifact.get("summary") or None,
            )
        # Mark this job pending_review. If it has no parent and no
        # dependents, it may be done — keep pending_review so the user
        # evaluates the artifact (quality gate).
        updated = store.update(job_id, state="pending_review")
        # Unblock dependents: for now, dependents stay blocked until an
        # evaluation passes; evaluation handles unblocking.
        return {"job": _serialize_job(updated) if updated else {}}

    @router.post("/jobs/{job_id}/evaluate")
    async def evaluate_job(job_id: str, request: Request) -> dict:
        """Evaluate a job's artifact: pass → completed, reject → returned (round+1)."""
        user = _require_user(request, auth_provider)
        body = await request.json()
        action = str(body.get("action") or "").strip()
        if action not in ("pass", "reject"):
            raise OmnigentError("action must be 'pass' or 'reject'", code=ErrorCode.INVALID_INPUT)
        comment = body.get("comment") or None
        store = _store(request)
        job = store.get(job_id)
        if job is None:
            raise OmnigentError(f"job {job_id!r} not found", code=ErrorCode.NOT_FOUND)
        store.add_evaluation(
            secrets.token_hex(16),
            job_id,
            action,
            str(user) if user else None,
            comment,
        )
        if action == "pass":
            updated = store.update(job_id, state="completed")
        else:
            # Reject → returned, round + 1, back to todo for rework.
            updated = store.update(job_id, state="returned", round=job.round + 1)
        return {"job": _serialize_job(updated) if updated else {}}

    @router.post("/jobs/{job_id}/state")
    async def set_job_state(job_id: str, request: Request) -> dict:
        """Manually set a job's state (e.g. blocked → in_progress on retry)."""
        _require_user(request, auth_provider)
        body = await request.json()
        state = str(body.get("state") or "").strip()
        valid = {"todo", "in_progress", "pending_review", "completed", "returned", "blocked"}
        if state not in valid:
            raise OmnigentError(f"invalid state {state!r}", code=ErrorCode.INVALID_INPUT)
        store = _store(request)
        updated = store.update(job_id, state=state)
        if updated is None:
            raise OmnigentError(f"job {job_id!r} not found", code=ErrorCode.NOT_FOUND)
        return {"job": _serialize_job(updated)}

    @router.delete("/jobs/{job_id}")
    async def delete_job(job_id: str, request: Request) -> dict:
        """Delete a job and its artifacts/evaluations."""
        _require_user(request, auth_provider)
        store = _store(request)
        if not store.delete(job_id):
            raise OmnigentError(f"job {job_id!r} not found", code=ErrorCode.NOT_FOUND)
        return {"deleted": job_id}


    return router
