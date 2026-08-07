"""ProjectMember entity — persisted in the ``project_members`` table."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass
class ProjectMember:
    """A user's membership in a team project.

    :param project_id: Owning team project id.
    :param user_id: Member user id.
    :param role: 1=member, 2=admin, 3=viewer. The owner is always
        implicitly an admin; explicit rows are additive.
    :param created_at: Unix epoch seconds at row creation.
    """

    project_id: str
    user_id: str
    role: int = 1
    created_at: int = 0
