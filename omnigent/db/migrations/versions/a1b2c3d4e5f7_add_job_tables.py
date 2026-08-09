"""add business tasks, task_artifacts, task_evaluations tables

Revision ID: a1b2c3d4e5f7
Revises: z9a2b3c4d5e6
Create Date: 2026-08-06 00:00:00.000000

Adds the outer-layer business-task tree (management dimension) on top of the
existing session-execution tree. Three tables:

- ``tasks`` — the business task tree (parent/child), lifecycle state,
  assignee / creator users, round counter, and the session it maps to.
- ``task_artifacts`` — products a task produced on completion (a file ref,
  a message summary, or none).
- ``task_evaluations`` — product-quality verdicts (pass/reject + comment)
  that drive task flow (approve → next stage; reject → redo with round+1).

All three are brand-new at the current schema state, so each carries the
tenant-partition ``workspace_id`` column as the leading PK member (matching
every other table after ``r1a2b3c4d5e6``). No foreign keys (schema Rule
R032): relationships are enforced by the application layer.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

from omnigent.db.db_models import Uuid16

revision: str = "a1b2c3d4e5f7"
down_revision: str | None = "c4d5e6f7a8b9"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Create the tasks / task_artifacts / task_evaluations tables."""
    op.create_table(
        "jobs",
        sa.Column("workspace_id", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("id", Uuid16(), nullable=False),
        # Parent task for the business-task tree; NULL = root task.
        sa.Column("parent_job_id", Uuid16(), nullable=True),
        # Root task id of the tree (itself when root).
        sa.Column("root_job_id", Uuid16(), nullable=True),
        sa.Column("title", sa.String(256), nullable=False),
        sa.Column("description", sa.LargeBinary(), nullable=True),
        # Lifecycle state as a stable int code (TASK_STATE:
        # todo=1, in_progress=2, pending_review=3, completed=4,
        # returned=5, blocked=6).
        sa.Column("state", sa.SmallInteger(), nullable=False, server_default="1"),
        # Round counter — incremented on each rejection/redo.
        sa.Column("round", sa.Integer(), nullable=False, server_default="1"),
        # Who the task is assigned to (the executor) / who created it.
        sa.Column("assignee_user_id", sa.String(128), nullable=True),
        sa.Column("created_by_user_id", sa.String(128), nullable=True),
        # Which role/agent handles this task (e.g. "architect-agent").
        sa.Column("agent_name", sa.String(128), nullable=True),
        # Comma-separated task ids this task depends on (application-parsed).
        sa.Column("depends_on", sa.String(512), nullable=True),
        # The session created to execute this task (relates to
        # conversations.id; no DB FK, Rule R032).
        sa.Column("session_id", Uuid16(), nullable=True),
        sa.Column("created_at", sa.Integer(), nullable=False),
        sa.Column("updated_at", sa.Integer(), nullable=True),
        sa.CheckConstraint("state IN (1, 2, 3, 4, 5, 6)", name="ck_jobs_state"),
        sa.PrimaryKeyConstraint("workspace_id", "id"),
    )
    op.create_index("ix_jobs_parent_job_id", "jobs", ["parent_job_id"], unique=False)
    op.create_index("ix_jobs_root_job_id", "jobs", ["root_job_id"], unique=False)
    op.create_index("ix_jobs_assignee", "jobs", ["assignee_user_id"], unique=False)
    op.create_index("ix_jobs_state", "jobs", ["state"], unique=False)
    op.create_index("ix_jobs_session_id", "jobs", ["session_id"], unique=False)

    op.create_table(
        "job_artifacts",
        sa.Column("workspace_id", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("id", Uuid16(), nullable=False),
        sa.Column("job_id", Uuid16(), nullable=False),
        # artifact_type as a stable int code (TASK_ARTIFACT_TYPE:
        # none=1, file=2, message=3).
        sa.Column("artifact_type", sa.SmallInteger(), nullable=False, server_default="1"),
        # For file: workspace-relative path. For message: text summary.
        sa.Column("ref", sa.String(2048), nullable=True),
        sa.Column("summary", sa.LargeBinary(), nullable=True),
        sa.Column("created_at", sa.Integer(), nullable=False),
        sa.CheckConstraint(
            "artifact_type IN (1, 2, 3)", name="ck_job_artifacts_type"
        ),
        sa.PrimaryKeyConstraint("workspace_id", "id"),
    )
    op.create_index("ix_job_artifacts_job_id", "job_artifacts", ["job_id"], unique=False)

    op.create_table(
        "job_evaluations",
        sa.Column("workspace_id", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("id", Uuid16(), nullable=False),
        sa.Column("job_id", Uuid16(), nullable=False),
        sa.Column("evaluator_user_id", sa.String(128), nullable=True),
        # action as a stable int code (TASK_EVALUATION_ACTION:
        # pass=1, reject=2).
        sa.Column("action", sa.SmallInteger(), nullable=False),
        sa.Column("comment", sa.LargeBinary(), nullable=True),
        sa.Column("created_at", sa.Integer(), nullable=False),
        sa.CheckConstraint("action IN (1, 2, 3)", name="ck_job_evaluations_action"),
        sa.PrimaryKeyConstraint("workspace_id", "id"),
    )
    op.create_index("ix_job_evaluations_job_id", "job_evaluations", ["job_id"], unique=False)
    op.create_index(
        "ix_job_evaluations_evaluator", "job_evaluations", ["evaluator_user_id"], unique=False
    )


def downgrade() -> None:
    """Drop the three task tables."""
    op.drop_table("job_evaluations")
    op.drop_table("job_artifacts")
    op.drop_table("jobs")
