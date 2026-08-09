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
import os
import secrets
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Request

from omnigent.db.utils import now_epoch
from omnigent.entities import Job, JobArtifact, JobEvaluation
from omnigent.errors import ErrorCode, OmnigentError
from omnigent.server.auth import AuthProvider
from omnigent.server.routes._auth_helpers import require_user as _require_user
from omnigent.stores.job_store import JobStore
from omnigent.server.workflow_executor import (
    dependencies_done,
    wants_auto_accept,
    wants_auto_approve,
)


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
        "config": t.config,
        "members": getattr(t, "member_ids", None) or [],
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


def _build_job_context(
    job, store: Any, project_store: Any
) -> str:
    """Assemble the handoff context for launching ``job``.

    A task inherits context from its whole ancestor chain — the project
    (name + members), the main task's requirements, and every completed
    ancestor's description + evaluations + artifact summaries. Siblings
    are NOT included (parallel work shouldn't cross-pollute unless
    explicitly dependent). Returns a markdown block prepended to the
    agent's first message so downstream phases know what happened
    upstream.
    """
    import logging

    _lgr = logging.getLogger("omnigent.server.routes.jobs")
    lines: list[str] = []
    project_name = None
    if job.project_id and project_store is not None:
        try:
            project = project_store.get(
                job.project_id, owner_user_id=job.created_by_user_id
            )
            if project is not None:
                project_name = project.name
        except Exception:  # noqa: BLE001 — context is best-effort
            _lgr.warning("job context: project lookup failed", exc_info=True)
    if project_name:
        lines.append(f"【项目】{project_name}")

    # Ancestor chain: root (main task) → ... → parent → this job.
    chain: list = []
    seen: set[str] = set()
    cur = job
    while cur is not None and cur.id not in seen:
        seen.add(cur.id)
        chain.append(cur)
        if cur.parent_job_id:
            cur = store.get(cur.parent_job_id)
        else:
            break
    chain.reverse()  # root first

    if len(chain) > 1:
        lines.append("【任务链】(从主任务到当前任务)")
        for idx, t in enumerate(chain):
            if t.id == job.id:
                lines.append(f"  → 当前任务: {t.title}（你在这里，请完成它）")
                continue
            state_note = "已完成" if t.state == "completed" else t.state
            lines.append(f"  {idx + 1}. {t.title} [{state_note}]")
            if t.description:
                lines.append(f"     需求/说明: {t.description}")
            if t.artifacts:
                for a in (t.artifacts or [])[:10]:
                    _desc = a.summary or a.ref
                    if _desc:
                        lines.append(f"     产出: {_desc}")
                if len(t.artifacts or []) > 10:
                    lines.append(f"     产出共 {len(t.artifacts)} 项（列出前 10）")
            else:
                lines.append(
                    "     产出: 见 workspace 文档（docs/、README 等，由前序 agent 撰写）"
                )
            for e in (t.evaluations or []):
                if e.comment:
                    lines.append(f"     评价: {e.comment}")

    # Sequential workflow handoff: completed SIBLINGS that ran before this
    # job (same parent, same tree, created earlier) are the prior phases of
    # a workflow — their conclusions must flow into this task too. Parallel
    # siblings (created later / not started) stay out.
    if job.parent_job_id:
        try:
            # store.get doesn't hydrate children — pull the whole tree
            # (root → children) and collect completed siblings that ran
            # before this job (sequential workflow handoff).
            tree = store.get_tree(job.root_job_id or job.parent_job_id)
            sibs: list = []
            for root in tree:
                for t in (root.children or []):
                    if (
                        t.id != job.id
                        and t.parent_job_id == job.parent_job_id
                        and t.state == "completed"
                        and (t.created_at or 0) <= (job.created_at or 0)
                    ):
                        sibs.append(t)
            if sibs:
                lines.append("【已完成的前序阶段】")
                for t in sorted(sibs, key=lambda t: t.created_at or 0):
                    lines.append(f"  • {t.title}")
                    if t.description:
                        lines.append(f"     需求/说明: {t.description}")
                    if t.artifacts:
                        for a in (t.artifacts or [])[:10]:
                            _desc = a.summary or a.ref
                            if _desc:
                                lines.append(f"     产出: {_desc}")
                        if len(t.artifacts or []) > 10:
                            lines.append(f"     产出共 {len(t.artifacts)} 项（列出前 10）")
                    else:
                        lines.append(
                            "     产出: 见 workspace 文档（docs/、README 等，由前序 agent 撰写）"
                        )
                    for e in (t.evaluations or []):
                        if e.comment:
                            lines.append(f"     评价: {e.comment}")
        except Exception:  # noqa: BLE001 — best-effort
            pass

    if job.description and len(chain) > 1:
        lines.append(f"【当前任务需求】{job.description}")
    elif not job.description:
        lines.append(f"【当前任务需求】请完成该任务：{job.title}")

    # Team-collaboration conventions (handoff docs + project memory) are
    # defined as an EDITABLE SKILL file, not hardcoded strings: the server
    # reads the skill body and prepends it, so behaviour can change without
    # code edits. (pi harness has no runtime skill injection, so the skill
    # body is composed into the launch context here.)
    try:
        import omnigent

        _skill_path = (
            Path(omnigent.__file__).resolve().parent.parent
            / "deploy/docker/host-configs/skills/handoff/SKILL.md"
        )
        if _skill_path.exists():
            from omnigent.spec.parser import _parse_skill

            _skill = _parse_skill(_skill_path)
            if _skill.content.strip():
                lines.append("")
                lines.append(f"【协作约定 · {_skill.description}】")
                lines.append(_skill.content.strip())
    except Exception as _skerr:  # noqa: BLE001 — skill is best-effort
        import logging as _skl
        _skl.getLogger("omnigent.server.routes.jobs").warning(
            "handoff skill inject failed: %s", _skerr, exc_info=True
        )

    return "\n".join(lines)


def _walk_titles(job, title: str) -> bool:
    """Return True if ``title`` appears anywhere in the job's tree."""
    if job.title == title:
        return True
    return any(_walk_titles(c, title) for c in (job.children or []))


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
        config = project.config or {}
        # Workflow spec lives in project.config.workflow (phases list), or
        # legacy config.phases. Each phase: {name, assignee|role, agent, mode}.
        workflow = config.get("workflow") or {}
        phases = workflow.get("phases") if isinstance(workflow, dict) else None
        if not phases:
            phases = config.get("phases") or []
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
        # Skip if a job with that title already exists under this project
        # root. get_tree returns the root(s) with children nested, so walk
        # the whole tree — a phase whose title already exists (manually
        # created or previously derived) must not be re-created.
        existing = store.get_tree(job.root_job_id or job.id) if job.root_job_id else []
        if any(_walk_titles(t, next_title) for t in existing):
            return
        # The phase's agent binds the executor: agent → owner (member)
        # → assignee. If the workflow phase carries an explicit assignee
        # it wins; otherwise resolve from the agent's owner_user_id.
        next_agent = next_phase.get("agent") or job.agent_name
        assignee = next_phase.get("assignee")
        if not assignee and next_agent:
            agent_store = getattr(request.app.state, "agent_store", None)
            if agent_store is not None:
                try:
                    _agent = await asyncio.to_thread(
                        agent_store.get_by_name, next_agent
                    )
                    if _agent is not None and _agent.owner_user_id:
                        assignee = _agent.owner_user_id
                except Exception:  # noqa: BLE001
                    pass
        new_job = store.create(
            secrets.token_hex(16),
            next_title,
            job.created_by_user_id or "admin",
            parent_job_id=job.root_job_id,
            root_job_id=job.root_job_id or job.id,
            description=next_phase.get("description"),
            assignee_user_id=assignee or None,
            agent_name=next_agent,
            state="todo",
            project_id=project_id,
        )
        # auto_accept: the assigned member accepts automatically (no
        # manual claim) — the job moves straight to in_progress.
        if (
            new_job is not None
            and new_job.assignee_user_id
            and next_phase.get("auto_accept")
        ):
            store.update(new_job.id, state="in_progress")
            _lgr.info(
                "job flow: %r auto-accepted by %s",
                next_title,
                new_job.assignee_user_id,
            )
        _lgr.info("job flow: created next phase %r after %r", next_title, job.title)
    except Exception as _exc:  # noqa: BLE001 — flow advance is best-effort
        _lgr.warning("job flow advance skipped: %s", _exc)


async def _notify_task_accepted(job, store: Any, request: Request) -> None:
    """D3: post an acceptance message into the main task's session.

    Called when the project MAIN task passes final evaluation. Builds a
    summary of every child phase (state + evaluation verdict) and appends
    it as an assistant message to the main session, so the collaboration
    transcript records the whole task chain's acceptance.
    """
    import logging

    _lgr = logging.getLogger("omnigent.server.routes.jobs")
    conversation_store = getattr(request.app.state, "conversation_store", None)
    if conversation_store is None:
        return
    try:
        tree = store.get_tree(job.root_job_id or job.id)
        lines = [f"✅ 任务「{job.title}」已验收完成"]
        children = []
        for root in tree:
            children.extend(root.children or [])
        for c in children:
            verdict = "通过"
            for e in (c.evaluations or []):
                if e.action == "reject":
                    verdict = "打回"
                elif e.action == "pass":
                    verdict = "通过"
            lines.append(f"  • {c.title}: {verdict}")
        text = "\n".join(lines)
        from omnigent.entities.conversation import (
            MessageData,
            NewConversationItem,
        )

        _item = NewConversationItem(
            type="message",
            response_id=secrets.token_hex(8),
            data=MessageData(
                role="assistant",
                agent=job.agent_name or "admin-agent",
                content=[{"type": "output_text", "text": text}],
            ),
        )
        await asyncio.to_thread(
            conversation_store.append, job.session_id, [_item]
        )
        _lgr.info("main session %s notified of acceptance", job.session_id)
    except Exception:  # noqa: BLE001 — notification is best-effort
        _lgr.warning("task acceptance notify failed", exc_info=True)


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
        if root is None or root.state in ("completed", "in_review"):
            return
        # D2: every EXECUTABLE node in the tree must be done — walk the
        # whole subtree (nested children + DAG dependents), not just the
        # direct children, so a partially-finished deep tree never marks
        # the root complete.
        def _all_done(nodes) -> bool:
            for n in nodes:
                if n.children:
                    if not _all_done(n.children):
                        return False
                elif n.state != "completed":
                    return False
            return True

        children = root.children or []
        if not children:
            return
        if _all_done(children):
            # All executable nodes done → root moves to in_review so
            # the project manager confirms completion (manual gate).
            if root.state != "in_review":
                store.update(root_id, state="in_review")
            _lgr.info("job root %s → in_review (all tree nodes done)", root_id)
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
                # The project may hold MULTIPLE task trees (a project can
                # have several main tasks). Return every project root as a
                # tree — stray independent tasks (project_id NULL) don't
                # leak in. Claim/launch remain owner-scoped downstream.
                roots = [
                    t
                    for t in store.list_roots()
                    if t.project_id == project_id or t.id == project_id
                ]
                jobs = []
                for r in roots:
                    jobs.extend(store.get_tree(r.root_job_id or r.id))
            else:
                jobs = store.list_roots()
        else:
            # Default view (task page, no project selected): every task tree
            # — each project root PLUS its children nested, so the board
            # shows the full tree for all projects at once.
            roots = store.list_roots()
            jobs = []
            for r in roots:
                jobs.extend(store.get_tree(r.root_job_id or r.id))
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

    @router.post("/jobs/{job_id}/members")
    async def add_job_member(job_id: str, request: Request) -> dict:
        """Add a member to the task's work team."""
        _require_user(request, auth_provider)
        body = await request.json()
        user_id = str(body.get("user_id") or "").strip()
        if not user_id:
            raise OmnigentError("user_id is required", code=ErrorCode.INVALID_INPUT)
        store = _store(request)
        job = store.get(job_id)
        if job is None:
            raise OmnigentError(f"job {job_id!r} not found", code=ErrorCode.NOT_FOUND)
        await asyncio.to_thread(store.add_member, job_id, user_id)
        return {"ok": True, "members": await asyncio.to_thread(store.list_members, job_id)}

    @router.get("/jobs/{job_id}/members")
    async def list_job_members(job_id: str, request: Request) -> dict:
        """List the task's work-team member user ids."""
        _require_user(request, auth_provider)
        store = _store(request)
        members = await asyncio.to_thread(store.list_members, job_id)
        return {"members": members}

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
        project_id: str | None = None
        if parent_job_id:
            parent = store.get(parent_job_id)
            if parent is None:
                raise OmnigentError(
                    f"parent job {parent_job_id!r} not found", code=ErrorCode.NOT_FOUND
                )
            root_job_id = parent.root_job_id or parent.id
            # Children inherit the parent's project — the client cannot
            # attach a child to a different project than its parent tree.
            project_id = parent.project_id
        else:
            # A root task only belongs to a project when the caller is the
            # project manager (admin) creating the main task; otherwise a
            # stray independent task would be attached to a project it is
            # not part of.
            project_id = body.get("project_id") or None
            if project_id:
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
                        "只有项目经理可创建项目主任务（指定 project_id）",
                        code=ErrorCode.FORBIDDEN,
                    )
        if not root_job_id:
            root_job_id = None  # this is itself a root
        job_id = secrets.token_hex(16)
        import json as _json
        _config_raw = body.get("config")
        _config_str = (
            _json.dumps(_config_raw, ensure_ascii=False)
            if isinstance(_config_raw, dict)
            else _config_raw
        )
        job = store.create(
            job_id,
            title,
            str(user) if user else None,
            parent_job_id=parent_job_id,
            root_job_id=root_job_id,
            description=body.get("description") or None,
            assignee_user_id=body.get("assignee_user_id") or None,
            # Main tasks (roots) bind the manager's agent by default so the
            # main session carries an agent (list visibility + graph root).
            agent_name=(
                body.get("agent_name")
                or ("admin-agent" if parent_job_id is None else None)
            ),
            depends_on=body.get("depends_on") or None,
            state=body.get("state") or "todo",
            require_approval=bool(body.get("require_approval") or False),
            project_id=project_id,
            config=_config_str,
        )

        # Auto-derive sub-tasks from the task's OWN workflow YAML. The
        # workflow uses the industry-standard ``steps`` list; each step has
        # a unique ``id`` (the reference key — depends_on refers to step
        # ids, never names, so duplicate names can't collide) plus a
        # display ``name``, optional ``agent`` and optional ``depends_on``.
        _config = _config_str
        if parent_job_id is None and _config and job_id:
            try:
                _cfg = _json.loads(_config)
                _wf = _cfg.get("workflow") or {}
                _steps = _wf.get("steps") if isinstance(_wf, dict) else _cfg.get("steps") or _wf.get("phases") or _cfg.get("phases") or []
                _prev_id: str | None = None
                # step id → job id (and step id → itself for late refs).
                _step_job_ids: dict[str, str] = {}
                for _st in _steps:
                    _stid = str(_st.get("id") or "").strip()
                    _ptitle = str(_st.get("name") or "").strip() or _stid
                    if not _ptitle:
                        continue
                    _agent_store = getattr(request.app.state, "agent_store", None)
                    _assignee = _st.get("assignee")
                    _agent_name = _st.get("agent")
                    if not _assignee and _agent_name and _agent_store is not None:
                        try:
                            _ag = await asyncio.to_thread(
                                _agent_store.get_by_name, _agent_name
                            )
                            if _ag is not None and _ag.owner_user_id:
                                _assignee = _ag.owner_user_id
                        except Exception:  # noqa: BLE001
                            pass
                    _dep = _st.get("depends_on")
                    if _dep is None and _prev_id:
                        _dep = _prev_id  # sequential by default
                    elif _dep:
                        # depends_on references STEP IDs — resolve each to
                        # its derived job id (fall back to raw value).
                        _resolved = []
                        if isinstance(_dep, list):
                            _dep_items = [str(d) for d in _dep]
                        else:
                            _dep_items = [d.strip() for d in str(_dep).split(",") if d.strip()]
                        for _dn in _dep_items:
                            if _dn in _step_job_ids:
                                _resolved.append(_step_job_ids[_dn])
                            else:
                                _resolved.append(_dn)
                        _dep = ",".join(_resolved)
                    _child = store.create(
                        secrets.token_hex(16),
                        _ptitle,
                        str(user) if user else None,
                        parent_job_id=job_id,
                        root_job_id=job_id,
                        description=_st.get("description"),
                        assignee_user_id=_assignee or None,
                        agent_name=_agent_name or None,
                        depends_on=_dep,
                        project_id=project_id,
                        config=_json.dumps(_st, ensure_ascii=False),
                    )
                    _prev_id = _child.id
                    if _stid:
                        _step_job_ids[_stid] = _child.id
            except Exception as _ce:  # noqa: BLE001 — phase derivation best-effort
                import logging as _lc

                _lc.getLogger("omnigent.server.routes.jobs").warning(
                    "phase derivation failed for %s: %s", job_id, _ce
                )

        # A1: creating the project MAIN task also creates its MAIN SESSION
        # (the collaboration root the execution sub-sessions hang under).
        # Child tasks create no session until claimed + launched.
        if parent_job_id is None and project_id and job_id:
            try:
                agent_store = getattr(request.app.state, "agent_store", None)
                conversation_store = getattr(request.app.state, "conversation_store", None)
                if conversation_store is not None:
                    _root_agent_id = None
                    if agent_store is not None and job.agent_name:
                        _ra = await asyncio.to_thread(
                            agent_store.get_by_name, job.agent_name
                        )
                        if _ra is not None:
                            _root_agent_id = _ra.id
                    _root_conv = await asyncio.to_thread(
                        conversation_store.create_conversation,
                        agent_id=_root_agent_id,
                        title=title,
                    )
                    if _root_conv is not None:
                        await asyncio.to_thread(
                            conversation_store.set_conversation_project,
                            _root_conv.id,
                            project_id,
                        )
                        # F5: project members get READ on the main session so
                        # they can see the collaboration tree (child_sessions).
                        try:
                            from omnigent.server.auth import LEVEL_EDIT

                            _perm = getattr(request.app.state, "permission_store", None)
                            _pstore = getattr(request.app.state, "project_store", None)
                            if _perm is not None and _pstore is not None:
                                _members = await asyncio.to_thread(
                                    _pstore.list_members, project_id
                                )
                                for _m in _members:
                                    _mid = getattr(_m, "user_id", None) or (
                                        _m.get("user_id") if isinstance(_m, dict) else None
                                    )
                                    if _mid:
                                        await asyncio.to_thread(
                                            _perm.ensure_user, _mid
                                        )
                                        await asyncio.to_thread(
                                            _perm.grant, _mid, _root_conv.id, LEVEL_EDIT
                                        )
                        except Exception:  # noqa: BLE001 — best-effort
                            pass
                    if _root_conv is not None:
                        await asyncio.to_thread(
                            store.update, job_id, session_id=_root_conv.id
                        )
            except Exception:  # noqa: BLE001 — main session is best-effort
                import logging as _lm

                _lm.getLogger("omnigent.server.routes.jobs").warning(
                    "main session creation failed for %s", job_id, exc_info=True
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
        # Main task: a project root (project-scoped, no parent) is the
        # aggregate container the manager manages — members must not claim
        # it. A standalone job (no project, no parent) with an assignee is
        # an ordinary task its assignee may claim.
        if (
            job.parent_job_id is None
            and job.root_job_id is None
            and job.project_id
        ):
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
        # C2: claiming a job whose DAG dependencies aren't done keeps it
        # pending (todo) — the executor is told what blocks it. Rules from
        # the YAML workflow (workflow_executor).
        _dep_ok, _dep_title = dependencies_done(job, store)
        if not _dep_ok:
            raise OmnigentError(
                f"任务依赖「{_dep_title}」尚未完成 — 请先完成依赖任务",
                code=ErrorCode.FORBIDDEN,
            )
        # Execution gate: jobs that require approval are claimed into
        # in_progress but stay PAUSED (🛡 marker) until an admin approves
        # execution — blocked is a marker, not a state.
        updated = store.update(
            job_id,
            state="in_progress",
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
        await asyncio.to_thread(
            store.add_evaluation,
            secrets.token_hex(16),
            job_id,
            "approve",
            str(user) if user else None,
            "管理员批准执行",
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
        """Mark a job complete with an optional artifact, moving to in_review."""
        user = _require_user(request, auth_provider)
        body = await request.json()
        store = _store(request)
        job = store.get(job_id)
        # Idempotency guard: an already-completed (or in-review) job must not
        # be re-submitted — a still-running pi might re-fire submit and flip
        # the state back to in_review after admin accepted it.
        if job is not None and job.state in ("completed", "in_review"):
            return {"job": _serialize_job(job)}
        if job is None:
            raise OmnigentError(f"job {job_id!r} not found", code=ErrorCode.NOT_FOUND)
        # Completion gate: the executor may only submit AFTER the agent has
        # finished executing. The reliable signal is the LAST MESSAGE's
        # created_at — the conversation row's updated_at is refreshed by
        # runner heartbeats even when the agent is idle, so it can't be
        # used. Require no new conversation items for AGENT_IDLE_GATE_S
        # (30s) before accepting submit.
        if job.session_id:
            try:
                conversation_store = getattr(request.app.state, "conversation_store", None)
                if conversation_store is not None:
                    from omnigent.db.utils import now_epoch as _now_epoch

                    last_ts = await asyncio.to_thread(
                        conversation_store.last_item_created_at, job.session_id
                    )
                    if last_ts is not None:
                        idle_s = _now_epoch() - last_ts
                        if idle_s < 30:
                            raise OmnigentError(
                                "agent 仍在执行中（最后消息 %ds 前）— 请等待执行稳定后再提交"
                                % idle_s,
                                code=ErrorCode.FORBIDDEN,
                            )
            except OmnigentError:
                raise
            except Exception:  # noqa: BLE001 — gate is best-effort
                pass
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

        # YAML rule (workflow_executor): if the step declares
        # ``auto_approve: true``, the task completes automatically once the
        # agent finishes — record an auto-approval evaluation for audit.
        # Otherwise it lands in_review for the manager's manual review.
        if wants_auto_approve(job):
            store.add_evaluation(
                secrets.token_hex(16),
                job_id,
                "auto_approve",
                str(user) if user else None,
                "自动审批（YAML auto_approve: true）",
            )
            updated = store.update(job_id, state="completed")
            import logging as _la

            _la.getLogger("omnigent.server.routes.jobs").info(
                "job %s auto-approved by workflow rule", job_id
            )
        else:
            # Mark this job in_review so the manager evaluates the artifact
            # (quality gate).
            updated = store.update(job_id, state="in_review")
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
            # The task is done — stop its live runner so a still-running pi
            # can't re-submit and flip the state back to in_review.
            if job.session_id:
                try:
                    runner_router = getattr(request.app.state, "runner_router", None)
                    if runner_router is not None:
                        from omnigent.server.routes.sessions import (
                            _stop_session_via_runner,
                        )

                        await _stop_session_via_runner(job.session_id, runner_router)
                except Exception:  # noqa: BLE001 — stop is best-effort
                    import logging as _lst

                    _lst.getLogger("omnigent.server.routes.jobs").warning(
                        "job pass: stop runner for %s failed", job.session_id
                    )
            # Flow template: when this job belongs to a project whose config
            # defines ordered phases, passing a phase auto-creates the next
            # phase job (assigned to the phase's configured executor) so the
            # project advances without manual task creation.
            await _maybe_advance_flow(job, store, request)
            # Acceptance is the PROJECT MANAGER's manual action (set_job_state
            # → in_review → evaluate pass); agents/models never mutate state.
            # Notify the main session once the manager accepts the root task.
            if job.parent_job_id is None and job.session_id:
                await _notify_task_accepted(job, store, request)
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
        valid = {"todo", "in_progress", "in_review", "completed", "returned"}
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
        # Project default workspace/host (official 4a): the project's config
        # carries soft defaults — prefill workspace from them when the caller
        # didn't supply one (host stays explicit; the executor picks theirs).
        if not body.get("workspace") and job.project_id:
            try:
                project_store = getattr(request.app.state, "project_store", None)
                if project_store is not None:
                    _proj = await asyncio.to_thread(
                        project_store.get, job.project_id, owner_user_id=job.created_by_user_id
                    )
                    if _proj is not None and _proj.config:
                        import json as _pj

                        _cfg = (
                            _pj.loads(_proj.config)
                            if isinstance(_proj.config, str)
                            else (_proj.config or {})
                        )
                        _defaults = (_cfg.get("defaults") or {}) if isinstance(_cfg, dict) else {}
                        if _defaults.get("workspace"):
                            body["workspace"] = _defaults["workspace"]
                            import logging as _lw
                            _lw.getLogger("omnigent.server.routes.jobs").info(
                                "launch: prefill workspace=%r from project defaults", _defaults["workspace"]
                            )
            except Exception:  # noqa: BLE001 — default is best-effort
                pass
        # C2: DAG dependencies must be completed before this job can run
        # (rule from the YAML workflow via workflow_executor).
        _dep_ok, _dep_title = dependencies_done(job, store)
        if not _dep_ok:
            raise OmnigentError(
                f"任务依赖「{_dep_title}」尚未完成 — 请先完成依赖任务",
                code=ErrorCode.FORBIDDEN,
            )
        # Gated jobs must be approved before they can be launched. The
        # claim keeps the job in_progress with a 🛡 marker; launch is the
        # gate — only an APPROVED gated job may launch (approval is
        # recorded as an evaluation with action "approve").
        if job.require_approval:
            _approved = any(
                e.action == "approve" for e in (job.evaluations or [])
            )
            if not _approved:
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

        # Create the conversation (the inner session). Task sessions hang
        # off the project's ROOT session (the main task's conversation, or
        # a lazily-created root for it) so the sub-agent execution graph
        # (SubagentsGraphView) renders the whole project's collaboration
        # tree: root → each member's task session. Roots themselves become
        # sub_agent children of that root session.
        root_conv_id: str | None = None
        if job.root_job_id or job.parent_job_id:
            root_id = job.root_job_id or job.id
            try:
                root_job = store.get(root_id)
                if root_job is not None and root_job.session_id:
                    root_conv_id = root_job.session_id
            except Exception:  # noqa: BLE001
                root_conv_id = None
            if root_conv_id is None:
                # Lazy-create a root session for the project's main task so
                # task sessions have a parent to hang under.
                try:
                    _root_agent = None
                    if root_job is not None and root_job.agent_name:
                        _ra = await asyncio.to_thread(
                            agent_store.get_by_name, root_job.agent_name
                        )
                        if _ra is not None:
                            _root_agent = _ra.id
                    _root = await asyncio.to_thread(
                        conversation_store.create_conversation,
                        agent_id=_root_agent,
                        title=root_job.title if root_job else job.title,
                        host_id=host_id,
                        workspace=body.get("workspace"),
                    )
                    if job.project_id:
                        await asyncio.to_thread(
                            conversation_store.set_conversation_project,
                            _root.id,
                            job.project_id,
                        )
                    if root_job is not None:
                        await asyncio.to_thread(
                            store.update, root_job.id, session_id=_root.id
                        )
                    root_conv_id = _root.id
                except Exception:  # noqa: BLE001 — best-effort
                    root_conv_id = None
        # Ensure the project main session grants project members EDIT so
        # sub-agent permission delegation (execution sessions parent to the
        # main session) lets their pi round-trip messages back.
        if root_conv_id and job.project_id:
            try:
                from omnigent.server.auth import LEVEL_EDIT

                _perm = getattr(request.app.state, "permission_store", None)
                _pstore = getattr(request.app.state, "project_store", None)
                if _perm is not None and _pstore is not None:
                    _members = await asyncio.to_thread(
                        _pstore.list_members, job.project_id
                    )
                    for _m in _members:
                        _mid = getattr(_m, "user_id", None) or (
                            _m.get("user_id") if isinstance(_m, dict) else None
                        )
                        if _mid:
                            await asyncio.to_thread(_perm.ensure_user, _mid)
                            await asyncio.to_thread(
                                _perm.grant, _mid, root_conv_id, LEVEL_EDIT
                            )
            except Exception:  # noqa: BLE001 — best-effort
                pass

        # Reuse the job's existing session if it already has one (a prior
        # launch may have created it) — re-creating a sub_agent session with
        # the same name under the same parent raises NameAlreadyExists.
        if job.session_id:
            conv = await asyncio.to_thread(
                conversation_store.get_conversation, job.session_id
            )
            if conv is None:
                conv = None
        else:
            conv = None
        if conv is None:
            # Execution session: kind=default so session-permission checks
            # DON'T delegate to the parent (main) session — the executor owns
            # this session directly (LEVEL_OWNER). parent_conversation_id is
            # still set for the collaboration graph. sub_agent kind would
            # delegate access to the parent, where members only hold READ,
            # breaking the pi message round-trip (needs edit).
            conv = await asyncio.to_thread(
                conversation_store.create_conversation,
                kind="default",
                parent_conversation_id=root_conv_id,
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
                host_conn = host_registry.get(host_id)
                if host_conn is None:
                    raise OmnigentError(
                        f"主机 {host_id!r} 连接不可用 — 请确认该主机在线后重试（或刷新主机列表）",
                        code=ErrorCode.RUNNER_UNAVAILABLE,
                    )


                launch_attempt = await _launch_runner_on_host(
                    conv,
                    conversation_store,
                    host_registry,
                    host_conn,
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
                    # Handoff context: ancestors' requirements, evaluations
                    # and artifact summaries flow into the agent's first
                    # message so downstream phases know what happened upstream.
                    project_store = getattr(request.app.state, "project_store", None)
                    prompt = _build_job_context(job, store, project_store)
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
