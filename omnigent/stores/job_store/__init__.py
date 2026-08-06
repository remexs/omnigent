"""Business task store — persists the outer collaboration task tree.

A :class:`Job` is a business task node (outer layer) that maps to an inner
session execution. This store owns the ``tasks`` / ``job_artifacts`` /
``job_evaluations`` tables: task CRUD + tree reads, artifact registration,
and product-quality evaluations that drive task flow.
"""

from __future__ import annotations

from abc import ABC, abstractmethod

from omnigent.entities import Job, JobArtifact, JobEvaluation


class JobStore(ABC):
    """Abstract base for business-task persistence."""

    def __init__(self, storage_location: str) -> None:
        self.storage_location = storage_location

    # ── Jobs ────────────────────────────────────────────────────

    @abstractmethod
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
    ) -> Job:
        """Insert a new task."""

    @abstractmethod
    def get(self, job_id: str) -> Job | None:
        """Return a task by id (with artifacts + evaluations)."""

    @abstractmethod
    def get_tree(self, root_job_id: str) -> list[Job]:
        """Return the full task tree rooted at *root_job_id* (children nested)."""

    @abstractmethod
    def list_by_assignee(self, user_id: str) -> list[Job]:
        """Return tasks assigned to a user (top-level, no children)."""

    @abstractmethod
    def list_by_creator(self, user_id: str) -> list[Job]:
        """Return tasks created by a user (top-level, no children)."""

    @abstractmethod
    def list_roots(self) -> list[Job]:
        """Return all root tasks."""

    @abstractmethod
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
    ) -> Job | None:
        """Update task fields; None means leave unchanged."""

    @abstractmethod
    def delete(self, job_id: str) -> bool:
        """Delete a task (and its artifacts/evaluations)."""

    # ── Artifacts ────────────────────────────────────────────────

    @abstractmethod
    def add_artifact(
        self,
        artifact_id: str,
        job_id: str,
        artifact_type: str,
        *,
        ref: str | None = None,
        summary: str | None = None,
    ) -> JobArtifact:
        """Register a product a task produced on completion."""

    @abstractmethod
    def list_artifacts(self, job_id: str) -> list[JobArtifact]:
        """Return a task's artifacts."""

    # ── Evaluations ──────────────────────────────────────────────

    @abstractmethod
    def add_evaluation(
        self,
        evaluation_id: str,
        job_id: str,
        action: str,
        evaluator_user_id: str | None,
        comment: str | None,
    ) -> JobEvaluation:
        """Record a product-quality verdict (pass/reject)."""

    @abstractmethod
    def list_evaluations(self, job_id: str) -> list[JobEvaluation]:
        """Return a task's evaluation history (oldest first)."""
