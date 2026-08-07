"""Add require_approval to jobs (execution gate).

Revision ID: a2b3c4d5e6f9
Revises: a2b3c4d5e6f8
Create Date: 2026-08-07

When set, launching the job's session requires an approval first
(execution gate): the executor can claim + launch, but the session
does not start until a reviewer/admin approves. Default false —
executors run directly.
"""

import sqlalchemy as sa
from alembic import op

revision: str = "a2b3c4d5e6f9"
down_revision: str | None = "a2b3c4d5e6f8"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "jobs",
        sa.Column("require_approval", sa.Boolean(), nullable=False, server_default=sa.false()),
    )


def downgrade() -> None:
    op.drop_column("jobs", "require_approval")
