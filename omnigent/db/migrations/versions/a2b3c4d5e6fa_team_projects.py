"""Team projects: kind + members + job association.

Revision ID: a2b3c4d5e6fa
Revises: a2b3c4d5e6f9
Create Date: 2026-08-07

Upgrades projects to team collaboration:
- projects.kind: 'personal' (default, owner-private session grouping)
  vs 'team' (project members share tasks/sessions; role-gated).
- project_members: (project_id, user_id, role) — 1=member, 2=admin,
  3=viewer. The owner is always implicitly an admin; rows are additive.
- jobs.project_id: associates a job tree with a team project so the
  project page can render its tasks and every member can see the
  project's task states.
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "a2b3c4d5e6fa"
down_revision: str | None = "a2b3c4d5e6f9"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # projects.kind — 'personal' | 'team'
    op.add_column(
        "projects",
        sa.Column(
            "kind",
            sa.String(16),
            nullable=False,
            server_default="personal",
        ),
    )

    # project_members
    op.create_table(
        "project_members",
        sa.Column("workspace_id", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("project_id", sa.LargeBinary(), nullable=False),
        sa.Column("user_id", sa.String(128), nullable=False),
        sa.Column("role", sa.SmallInteger(), nullable=False, server_default="1"),
        sa.Column("created_at", sa.Integer(), nullable=False),
        sa.PrimaryKeyConstraint("workspace_id", "project_id", "user_id"),
    )
    op.create_index(
        "ix_project_members_user",
        "project_members",
        ["workspace_id", "user_id"],
        unique=False,
    )

    # jobs.project_id
    op.add_column("jobs", sa.Column("project_id", sa.LargeBinary(), nullable=True))
    op.create_index("ix_jobs_project_id", "jobs", ["project_id"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_jobs_project_id", table_name="jobs")
    op.drop_column("jobs", "project_id")
    op.drop_index("ix_project_members_user", table_name="project_members")
    op.drop_table("project_members")
    op.drop_column("projects", "kind")
