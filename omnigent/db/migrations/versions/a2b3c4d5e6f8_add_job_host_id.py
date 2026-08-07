"""Add host_id to jobs (execution host).

Revision ID: a2b3c4d5e6f8
Revises: a1b2c3d4e5f7
Create Date: 2026-08-07

Records which host executed a job (set at launch time) so the web UI
can show "executed on <host>" without joining conversations.
"""

import sqlalchemy as sa
from alembic import op

revision: str = "a2b3c4d5e6f8"
down_revision: str | None = "a1b2c3d4e5f7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "jobs",
        sa.Column("host_id", sa.String(64), nullable=True),
    )
    op.create_index("ix_jobs_host_id", "jobs", ["host_id"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_jobs_host_id", table_name="jobs")
    op.drop_column("jobs", "host_id")
