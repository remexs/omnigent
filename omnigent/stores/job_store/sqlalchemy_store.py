"""SQLAlchemy-backed implementation of :class:`JobStore`.

Persists the business task tree (``tasks`` / ``job_artifacts`` /
``job_evaluations`` tables) via the SQLAlchemy ORM.
"""

from __future__ import annotations

import builtins

from sqlalchemy import asc, delete, select

from omnigent.db.db_models import (
    SqlJobArtifact,
    SqlJobEvaluation,
    SqlJob,
    current_workspace_id,
)
from omnigent.db.enum_codecs import (
    decode_job_artifact_type,
    decode_job_evaluation_action,
    decode_job_state,
    encode_job_artifact_type,
    encode_job_evaluation_action,
    encode_job_state,
)
from omnigent.db.utils import get_or_create_engine, make_managed_session_maker, now_epoch
from omnigent.entities import Job, JobArtifact, JobEvaluation
from omnigent.stores.job_store import JobStore


def _job_to_entity(row: SqlJob) -> Job:
    """Convert a :class:`SqlJob` ORM row to a :class:`Job` dataclass."""
    return Job(
        id=row.id,
        title=row.title,
        state=decode_job_state(row.state),
        round=row.round,
        created_at=row.created_at,
        parent_job_id=row.parent_job_id,
        root_job_id=row.root_job_id,
        description=row.description,
        assignee_user_id=row.assignee_user_id,
        created_by_user_id=row.created_by_user_id,
        agent_name=row.agent_name,
        depends_on=row.depends_on,
        session_id=row.session_id,
        host_id=row.host_id,
        require_approval=row.require_approval,
        project_id=row.project_id,
        updated_at=row.updated_at,
    )


def _artifact_to_entity(row: SqlJobArtifact) -> JobArtifact:
    return JobArtifact(
        id=row.id,
        job_id=row.job_id,
        artifact_type=decode_job_artifact_type(row.artifact_type),
        created_at=row.created_at,
        ref=row.ref,
        summary=row.summary,
    )


def _evaluation_to_entity(row: SqlJobEvaluation) -> JobEvaluation:
    return JobEvaluation(
        id=row.id,
        job_id=row.job_id,
        action=decode_job_evaluation_action(row.action),
        created_at=row.created_at,
        evaluator_user_id=row.evaluator_user_id,
        comment=row.comment,
    )


class SqlAlchemyJobStore(JobStore):
    """SQLAlchemy-backed :class:`JobStore`."""

    def __init__(self, storage_location: str) -> None:
        super().__init__(storage_location)
        self._engine = get_or_create_engine(storage_location)
        self._session = make_managed_session_maker(self._engine)

    # ── Jobs ────────────────────────────────────────────────────

    def create(
        self,
        job_id: str,
        title: str,
        created_by_user_id: str | None,
        *,
        parent_job_id: str | None = None,
        root_job_id: str | None = None,
        description: str | None = None,
        assignee_user_id: str | None = None,
        agent_name: str | None = None,
        depends_on: str | None = None,
        state: str = "todo",
        round: int = 1,
        host_id: str | None = None,
        require_approval: bool = False,
        project_id: str | None = None,
    ) -> Job:
        row = SqlJob(
            id=job_id,
            title=title,
            description=description,
            state=encode_job_state(state),
            round=round,
            parent_job_id=parent_job_id,
            root_job_id=root_job_id,
            assignee_user_id=assignee_user_id,
            created_by_user_id=created_by_user_id,
            agent_name=agent_name,
            depends_on=depends_on,
            session_id=None,
            host_id=host_id,
            require_approval=require_approval,
            project_id=project_id,
            created_at=now_epoch(),
            updated_at=None,
        )
        with self._session() as session:
            session.add(row)
            session.flush()
            return _job_to_entity(row)

    def get(self, job_id: str) -> Job | None:
        with self._session() as session:
            row = session.get(SqlJob, (current_workspace_id(), job_id))
            if row is None:
                return None
            task = _job_to_entity(row)
            task.artifacts = self.list_artifacts(job_id)
            task.evaluations = self.list_evaluations(job_id)
            return task

    def get_tree(self, root_job_id: str) -> list[Job]:
        from sqlalchemy import or_

        with self._session() as session:
            rows = (
                session.execute(
                    select(SqlJob)
                    .where(
                        or_(
                            SqlJob.root_job_id == root_job_id,
                            SqlJob.id == root_job_id,
                        )
                    )
                    .order_by(asc(SqlJob.created_at))
                )
                .scalars()
                .all()
            )
        tasks = {r.id: _job_to_entity(r) for r in rows}
        # Attach artifacts + evaluations for every task in the tree.
        for t in tasks.values():
            t.artifacts = self.list_artifacts(t.id)
            t.evaluations = self.list_evaluations(t.id)
        roots: list[Job] = []
        for t in tasks.values():
            if t.parent_job_id and t.parent_job_id in tasks:
                tasks[t.parent_job_id].children.append(t)
            else:
                roots.append(t)
        return roots

    def list_by_assignee(self, user_id: str) -> list[Job]:
        with self._session() as session:
            rows = (
                session.execute(
                    select(SqlJob)
                    .where(SqlJob.assignee_user_id == user_id)
                    .order_by(asc(SqlJob.created_at))
                )
                .scalars()
                .all()
            )
        return [_job_to_entity(r) for r in rows]

    def list_by_creator(self, user_id: str) -> list[Job]:
        with self._session() as session:
            rows = (
                session.execute(
                    select(SqlJob)
                    .where(SqlJob.created_by_user_id == user_id)
                    .order_by(asc(SqlJob.created_at))
                )
                .scalars()
                .all()
            )
        return [_job_to_entity(r) for r in rows]

    def list_roots(self) -> builtins.list[Job]:
        with self._session() as session:
            rows = (
                session.execute(
                    select(SqlJob).where(SqlJob.parent_job_id.is_(None)).order_by(asc(SqlJob.created_at))
                )
                .scalars()
                .all()
            )
        jobs = [_job_to_entity(r) for r in rows]
        for t in jobs:
            t.evaluations = self.list_evaluations(t.id)
        return jobs

    def update(
        self,
        job_id: str,
        *,
        state: str | None = None,
        round: int | None = None,
        assignee_user_id: str | None = None,
        agent_name: str | None = None,
        session_id: str | None = None,
        depends_on: str | None = None,
        host_id: str | None = None,
        require_approval: bool | None = None,
    ) -> Job | None:
        with self._session() as session:
            row = session.get(SqlJob, (current_workspace_id(), job_id))
            if row is None:
                return None
            if state is not None:
                row.state = encode_job_state(state)
            if round is not None:
                row.round = round
            if assignee_user_id is not None:
                row.assignee_user_id = assignee_user_id
            if agent_name is not None:
                row.agent_name = agent_name
            if session_id is not None:
                row.session_id = session_id
            if host_id is not None:
                row.host_id = host_id
            if require_approval is not None:
                row.require_approval = require_approval
            if depends_on is not None:
                row.depends_on = depends_on
            row.updated_at = now_epoch()
            session.flush()
            return _job_to_entity(row)

    def delete(self, job_id: str) -> bool:
        with self._session() as session:
            session.execute(delete(SqlJobEvaluation).where(SqlJobEvaluation.job_id == job_id))
            session.execute(delete(SqlJobArtifact).where(SqlJobArtifact.job_id == job_id))
            row = session.get(SqlJob, (current_workspace_id(), job_id))
            if row is None:
                return False
            session.delete(row)
            session.flush()
            return True

    # ── Artifacts ────────────────────────────────────────────────

    def add_artifact(
        self,
        artifact_id: str,
        job_id: str,
        artifact_type: str,
        *,
        ref: str | None = None,
        summary: str | None = None,
    ) -> JobArtifact:
        row = SqlJobArtifact(
            id=artifact_id,
            job_id=job_id,
            artifact_type=encode_job_artifact_type(artifact_type),
            ref=ref,
            summary=summary,
            created_at=now_epoch(),
        )
        with self._session() as session:
            session.add(row)
            session.flush()
            return _artifact_to_entity(row)

    def list_artifacts(self, job_id: str) -> builtins.list[JobArtifact]:
        with self._session() as session:
            rows = (
                session.execute(
                    select(SqlJobArtifact)
                    .where(SqlJobArtifact.job_id == job_id)
                    .order_by(asc(SqlJobArtifact.created_at))
                )
                .scalars()
                .all()
            )
        return [_artifact_to_entity(r) for r in rows]

    # ── Evaluations ──────────────────────────────────────────────

    def add_evaluation(
        self,
        evaluation_id: str,
        job_id: str,
        action: str,
        evaluator_user_id: str | None,
        comment: str | None,
    ) -> JobEvaluation:
        row = SqlJobEvaluation(
            id=evaluation_id,
            job_id=job_id,
            evaluator_user_id=evaluator_user_id,
            action=encode_job_evaluation_action(action),
            comment=comment,
            created_at=now_epoch(),
        )
        with self._session() as session:
            session.add(row)
            session.flush()
            return _evaluation_to_entity(row)

    def list_evaluations(self, job_id: str) -> builtins.list[JobEvaluation]:
        with self._session() as session:
            rows = (
                session.execute(
                    select(SqlJobEvaluation)
                    .where(SqlJobEvaluation.job_id == job_id)
                    .order_by(asc(SqlJobEvaluation.created_at))
                )
                .scalars()
                .all()
            )
        return [_evaluation_to_entity(r) for r in rows]

    def find_by_session(self, session_id: str) -> str | None:
        with self._session() as session:
            row = session.execute(
                select(SqlJob).where(SqlJob.session_id == session_id)
            ).scalars().first()
            return row.id if row is not None else None
