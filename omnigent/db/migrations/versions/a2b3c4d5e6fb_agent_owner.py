"""Add owner_user_id to agents (member-owned agent specs).

Revision ID: a2b3c4d5e6fb
Revises: a2b3c4d5e6fa
Create Date: 2026-08-07

Each project member may customize their own agent spec (how their agent
works). ``owner_user_id`` marks the owning member; NULL for shared
template agents (built-ins). Members see/use their own agent, and the
project workflow spec references member agents by name.
"""

import sqlalchemy as sa
from alembic import op

revision: str = "a2b3c4d5e6fb"
down_revision: str | None = "a2b3c4d5e6fa"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "agents",
        sa.Column("owner_user_id", sa.String(128), nullable=True),
    )
    op.create_index(
        "ix_agents_owner_user_id", "agents", ["workspace_id", "owner_user_id"], unique=False
    )


def downgrade() -> None:
    op.drop_index("ix_agents_owner_user_id", table_name="agents")
    op.drop_column("agents", "owner_user_id")
