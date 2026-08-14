"""Add config to jobs (task workflow config).

Revision ID: a2b3c4d5e6fc
Revises: a2b3c4d5e6fb
Create Date: 2026-08-14

The ``jobs.config`` column (compact JSON: task tree / workflow config for
multi-phase jobs) was in the SQLAlchemy model but missing from every
migration — sqlite deploys got it via ``metadata.create_all``, while the
alembic-migrated Postgres schema did not. Add it so job reads stop failing
with ``column jobs.config does not exist``.
"""

import sqlalchemy as sa
from alembic import op

revision: str = "a2b3c4d5e6fc"
down_revision: str | None = "a2b3c4d5e6fb"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "jobs",
        sa.Column("config", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("jobs", "config")
