"""Business job management API (``/v1/jobs``).

Outer collaboration layer: create / assign / claim / evaluate business jobs
that map to inner session executions. The job tree drives multi-role,
multi-user coordination — a project manager assigns jobs to executors, who
claim them (spawning a session on their own host), and reviewers evaluate the
produced artifacts to approve the next stage or send the job back for a
rework (round + 1).
"""

from __future__ import annotations

import asyncio
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
        "host_id": t.host_id,
        "require_approval": t.require_approval,
        "project_id": t.project_id,
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


async def _maybe_advance_flow(
    job, store: Any, request: Request
) -> None:
    """Auto-create the next project phase job after a phase passes.

    Reads the owning project's ``config.phases`` (ordered list of
    ``{"name", "assignee", "agent"}``) and creates the phase whose title
    follows the completed job's title, unless a sibling job with that
    title already exists. Best-effort: any project/config/phase issue
    logs and is skipped so evaluation still succeeds.
    """
    import logging

    _lgr = logging.getLogger("omnigent.server.routes.jobs")
    project_id = getattr(job, "project_id", None)
    if not project_id:
        return
    try:
        project_store = getattr(request.app.state, "project_store", None)
        if project_store is None:
            return
        project = await asyncio.to_thread(
            project_store.get, project_id, owner_user_id=job.created_by_user_id
        )
        if project is None:
            return
        phases = (project.config or {}).get("phases") or []
        if not phases:
            return
        titles = [p.get("name") for p in phases if p.get("name")]
        if job.title not in titles:
            return
        idx = titles.index(job.title)
        if idx + 1 >= len(titles):
            return  # last phase — project complete
        next_phase = phases[idx + 1]
        next_title = next_phase.get("name")
        # Skip if a job with that title already exists under this project root.
        roots = store.list_roots()
        root = next((t for t in roots if t.id == job.root_job_id), None)
        existing = store.get_tree(job.root_job_id or job.id) if job.root_job_id else []
        if any(t.title == next_title for t in existing):
            return
        store.create(
            secrets.token_hex(16),
            next_title,
            job.created_by_user_id or "admin",
            parent_job_id=job.root_job_id,
            root_job_id=job.root_job_id or job.id,
            description=next_phase.get("description"),
            assignee_user_id=next_phase.get("assignee") or None,
            agent_name=next_phase.get("agent") or job.agent_name,
            state="todo",
            project_id=project_id,
        )
        _lgr.info("job flow: created next phase %r after %r", next_title, job.title)
    except Exception as _exc:  # noqa: BLE001 — flow advance is best-effort
        _lgr.warning("job flow advance skipped: %s", _exc)


async def _maybe_complete_root(
    job, store: Any, request: Request
) -> None:
    """Mark the root job completed once ALL its children are completed.

    The root (main task) is an aggregate container with no executor of
    its own; its completion is derived purely from its children. Called
    after each child passes evaluation (or completes).
    """
    import logging

    _lgr = logging.getLogger("omnigent.server.routes.jobs")
    root_id = job.root_job_id or job.id
    if job.parent_job_id is None:
        return  # job IS the root — nothing to check
    try:
        tree = store.get_tree(root_id)
        root = next((t for t in tree if t.id == root_id), None)
        if root is None or root.state == "completed":
            return
        children = [t for t in tree if t.parent_job_id == root_id]
        if not children:
            return
        if all(c.state == "completed" for c in children):
            store.update(root_id, state="completed")
            _lgr.info("job root %s auto-completed (all children done)", root_id)
    except Exception as _exc:  # noqa: BLE001 — best-effort
        _lgr.warning("root auto-complete skipped: %s", _exc)


def create_jobs_router(
    *, auth_provider: AuthProvider | None = None, account_store: Any | None = None
) -> APIRouter:
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
        user_id = _require_user(request, auth_provider)
        store = _store(request)
        q = request.query_params
        scope = q.get("scope", "roots")  # roots | assigned | created | project
        if scope == "assigned" and user_id:
            jobs = store.list_by_assignee(user_id)
        elif scope == "created" and user_id:
            jobs = store.list_by_creator(user_id)
        elif scope == "project":
            project_id = q.get("project_id") or q.get("root_id")
            if project_id:
                # Only project members (or admin) may view the project's
                # task tree; everyone who can view sees ALL tasks/progress,
                # but claim/launch are still owner-scoped.
                project_store = getattr(request.app.state, "project_store", None)
                if project_store is not None:
                    project = await asyncio.to_thread(
                        project_store.get, project_id, owner_user_id=str(user_id) if user_id else None
                    )
                    if project is None:
                        raise OmnigentError(
                            "项目不存在或您不是项目成员", code=ErrorCode.NOT_FOUND
                        )
                roots = [
                    t
                    for t in store.list_roots()
                    if t.project_id == project_id or t.id == project_id
                ]
                jobs = []
                for r in roots:
                    tree = store.get_tree(r.root_job_id or r.id)
                    jobs.extend(tree)
            else:
                jobs = store.list_roots()
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
            require_approval=bool(body.get("require_approval") or False),
            project_id=body.get("project_id") or None,
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
        # Claim is owner-scoped: a project member may only claim jobs
        # assigned to them (assignee_user_id == caller). The project
        # manager (admin) may claim any job (to re-run/review).
        # Main task (root, parent_job_id is null): only the manager may
        # claim/manage it — members see it as an aggregate progress bar.
        if job.parent_job_id is None and job.root_job_id is None:
            account_store = getattr(request.app.state, "account_store", None)
            is_admin = False
            if account_store is not None:
                try:
                    is_admin = await asyncio.to_thread(
                        account_store.is_admin, str(user)
                    )
                except Exception:  # noqa: BLE001
                    is_admin = False
            if not is_admin:
                raise OmnigentError(
                    "主任务由项目经理管理 — 项目成员只能领取分配给自己的子任务",
                    code=ErrorCode.FORBIDDEN,
                )
        if job.assignee_user_id and user and str(user) != job.assignee_user_id:
            # Admin override for re-dispatch/review.
            account_store = getattr(request.app.state, "account_store", None)
            is_admin = False
            if account_store is not None:
                try:
                    is_admin = await asyncio.to_thread(
                        account_store.is_admin, str(user)
                    )
                except Exception:  # noqa: BLE001
                    is_admin = False
            if not is_admin:
                raise OmnigentError(
                    f"该任务分配给了 {job.assignee_user_id} — 只能领取分配给自己的任务",
                    code=ErrorCode.FORBIDDEN,
                )
        # Execution gate: jobs that require approval do not go straight to
        # in_progress — they sit in blocked (waiting) until an admin
        # approves execution. Executors can still claim (become assignee).
        next_state = "blocked" if job.require_approval else "in_progress"
        updated = store.update(
            job_id,
            state=next_state,
            assignee_user_id=str(user) if user else None,
        )
        return {"job": _serialize_job(updated) if updated else {}}

    @router.post("/jobs/{job_id}/approve-execution")
    async def approve_execution(job_id: str, request: Request) -> dict:
        """Approve a gated job's execution (admin only), unblocking launch."""
        user = _require_user(request, auth_provider)
        is_admin = False
        if account_store is not None:
            try:
                is_admin = await asyncio.to_thread(account_store.is_admin, str(user))
            except Exception:  # noqa: BLE001 — non-accounts stores lack is_admin
                is_admin = False
        if not is_admin:
            raise OmnigentError(
                "仅管理员可批准任务执行", code=ErrorCode.FORBIDDEN
            )
        store = _store(request)
        job = store.get(job_id)
        if job is None:
            raise OmnigentError(f"job {job_id!r} not found", code=ErrorCode.NOT_FOUND)
        if not job.require_approval:
            raise OmnigentError(
                "该任务未启用执行审批", code=ErrorCode.INVALID_INPUT
            )
        updated = store.update(job_id, state="in_progress")
        return {"job": _serialize_job(updated) if updated else {}}

    @router.post("/jobs/{job_id}/reassign")
    async def reassign_job(job_id: str, request: Request) -> dict:
        """Reassign a job to a different executor (manager action).

        The project manager (admin) can move a job to another member —
        e.g. after a reject, or when the original assignee is unavailable.
        Also clears the session binding so the new assignee can launch.
        """
        user = _require_user(request, auth_provider)
        body = await request.json()
        new_assignee = str(body.get("assignee_user_id") or "").strip()
        if not new_assignee:
            raise OmnigentError(
                "assignee_user_id is required", code=ErrorCode.INVALID_INPUT
            )
        account_store = getattr(request.app.state, "account_store", None)
        is_admin = False
        if account_store is not None:
            try:
                is_admin = await asyncio.to_thread(account_store.is_admin, str(user))
            except Exception:  # noqa: BLE001
                is_admin = False
        if not is_admin:
            raise OmnigentError(
                "仅项目经理可重新分配任务", code=ErrorCode.FORBIDDEN
            )
        store = _store(request)
        job = store.get(job_id)
        if job is None:
            raise OmnigentError(f"job {job_id!r} not found", code=ErrorCode.NOT_FOUND)
        updated = store.update(
            job_id,
            assignee_user_id=new_assignee,
            state="todo",
            session_id=None,
            host_id=None,
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
            # Flow template: when this job belongs to a project whose config
            # defines ordered phases, passing a phase auto-creates the next
            # phase job (assigned to the phase's configured executor) so the
            # project advances without manual task creation.
            await _maybe_advance_flow(job, store, request)
            # Root auto-completion: once every child of a root job is
            # completed, mark the root itself completed (the root is an
            # aggregate container — progress bar — with no executor).
            await _maybe_complete_root(job, store, request)
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

    @router.post("/jobs/{job_id}/launch")
    async def launch_job(job_id: str, request: Request) -> dict:
        """Claim a job and launch its session on the assignee's host.

        Creates a session for the job's agent, grants ownership to the
        assignee, and dispatches the job description so the agent runs —
        mirroring the scheduled-task fire path. Requires a host id in the
        body (the assignee's online host).
        """
        user = _require_user(request, auth_provider)
        body = await request.json()
        host_id = body.get("host_id")
        if not host_id:
            raise OmnigentError(
                "host_id is required (the assignee's online host)",
                code=ErrorCode.INVALID_INPUT,
            )
        store = _store(request)
        job = store.get(job_id)
        if job is None:
            raise OmnigentError(f"job {job_id!r} not found", code=ErrorCode.NOT_FOUND)
        if not job.agent_name:
            raise OmnigentError(
                "job has no agent_name — set an agent before launching",
                code=ErrorCode.INVALID_INPUT,
            )
        # Gated jobs must be approved before they can be launched.
        if job.require_approval and job.state != "in_progress":
            raise OmnigentError(
                "该任务需要管理员批准执行后才能启动 — 请等待审批通过",
                code=ErrorCode.FORBIDDEN,
            )
        # Execution is owned by the host's owner: only the machine's owner
        # may launch a runner on it (the orchestrator/admin can see all hosts
        # for scheduling, but cannot execute on someone else's machine).
        # Dispatch to another executor instead — claim/assign the job to
        # them and let them launch on their own host.
        if user is not None:
            host_store = getattr(request.app.state, "host_store", None)
            host_rec = (
                await asyncio.to_thread(host_store.get_host, host_id)
                if host_store is not None
                else None
            )
            if host_rec is None:
                raise OmnigentError(
                    f"host {host_id!r} not found", code=ErrorCode.NOT_FOUND
                )
            if str(user) != host_rec.user_id:
                raise OmnigentError(
                    "只能在自己的主机上执行 — 如需调度请把任务转发给该主机所有者，由他们在自己的机器上启动",
                    code=ErrorCode.FORBIDDEN,
                )
        assignee = job.assignee_user_id or (str(user) if user else None)

        # Resolve the agent id from the agent name.
        agent_store = getattr(request.app.state, "agent_store", None)
        conversation_store = getattr(request.app.state, "conversation_store", None)
        permission_store = getattr(request.app.state, "permission_store", None)
        runner_router = getattr(request.app.state, "runner_router", None)
        tunnel_registry = getattr(request.app.state, "tunnel_registry", None)
        host_registry = getattr(request.app.state, "host_registry", None)
        if not (agent_store and conversation_store):
            raise OmnigentError(
                "session stores not configured on this server",
                code=ErrorCode.INTERNAL_ERROR,
            )

        agent = await asyncio.to_thread(
            agent_store.get_by_name, job.agent_name
        )
        if agent is None:
            raise OmnigentError(
                f"agent {job.agent_name!r} not found", code=ErrorCode.NOT_FOUND
            )

        # Create the conversation (the inner session).
        conv = await asyncio.to_thread(
            conversation_store.create_conversation,
            agent_id=agent.id,
            title=job.title,
            host_id=host_id,
            workspace=body.get("workspace"),
        )
        # File the task's session under its project so project members can
        # find it (task session lives under the project; personal sessions
        # stay private with project_id = NULL).
        if job.project_id and conversation_store is not None:
            try:
                await asyncio.to_thread(
                    conversation_store.set_conversation_project,
                    conv.id,
                    job.project_id,
                )
            except Exception:  # noqa: BLE001 — best-effort filing
                import logging as _lf

                _lf.getLogger("omnigent.server.routes.jobs").warning(
                    "job session filing skipped: %s", exc_info=True
                )
        # Grant ownership to the assignee so they can see / continue it.
        # Also grant to the host owner (the executor machine's user) so
        # their runner can fetch the agent spec (agent/contents) while
        # executing the session.
        if permission_store is not None and assignee:
            from omnigent.server.auth import LEVEL_OWNER, RESERVED_USER_LOCAL

            owner = assignee or RESERVED_USER_LOCAL
            await asyncio.to_thread(permission_store.ensure_user, owner)
            await asyncio.to_thread(
                permission_store.grant, owner, conv.id, LEVEL_OWNER
            )
        if permission_store is not None and host_registry is not None:
            _host_rec = host_registry.get(host_id)
            _host_owner = getattr(_host_rec, "owner", None)
            if _host_owner and _host_owner != assignee:
                from omnigent.server.auth import LEVEL_OWNER as _LO

                await asyncio.to_thread(permission_store.ensure_user, _host_owner)
                await asyncio.to_thread(
                    permission_store.grant, _host_owner, conv.id, _LO
                )

        # Record the session on the job.
        store.update(job_id, session_id=conv.id, state="in_progress", host_id=host_id)

        # Dispatch the job description so the agent runs.
        from omnigent.server.routes.sessions import (
            _dispatch_session_event_to_runner,
            _ensure_runner_session_initialized,
            _launch_runner_on_host,
            _wait_for_runner_client,
        )
        from omnigent.server.schemas import SessionEventInput as _SEI

        if host_registry is not None and runner_router is not None:
            try:
                launch_attempt = await _launch_runner_on_host(
                    conv,
                    conversation_store,
                    host_registry,
                    host_registry.get(host_id),
                )
                runner_client = None
                if launch_attempt.error_code is None:
                    runner_client = await _wait_for_runner_client(
                        conv.id,
                        runner_router,
                        tunnel_registry,
                        runner_id=launch_attempt.runner_id,
                        timeout_s=30.0,
                    )
                if runner_client is not None:
                    fresh = await asyncio.to_thread(
                        conversation_store.get_conversation, conv.id
                    )
                    conv_for = fresh or conv
                    await _ensure_runner_session_initialized(
                        conv.id, conv_for, runner_client, conversation_store
                    )
                    prompt = job.description or f"请完成该任务：{job.title}"
                    msg_body = _SEI(
                        type="message",
                        data={
                            "role": "user",
                            "content": [
                                {"type": "input_text", "text": prompt}
                            ],
                        },
                    )
                    await _dispatch_session_event_to_runner(
                        conv.id,
                        conv_for,
                        msg_body,
                        conversation_store,
                        runner_client,
                        agent_name=None,
                        file_store=None,
                        artifact_store=None,
                        created_by=assignee,
                        runner_router=runner_router,
                    )
            except Exception as _exc:  # noqa: BLE001 - session launch is best-effort
                import logging

                logging.getLogger("omnigent.server.routes.jobs").warning(
                    "job launch dispatch failed for %s: %s", job_id, _exc
                )

        return {
            "job": _serialize_job(store.get(job_id) if store.get(job_id) else job),
            "session_id": conv.id,
        }


    return router
