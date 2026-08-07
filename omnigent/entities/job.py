"""Business job entities — outer collaboration layer.

A :class:`Job` is a business task (a node in the outer job tree) that maps
to an inner session execution. Jobs carry lifecycle state, an assignee /
creator, a round counter (incremented on each reject/redo), and optional
product artifacts plus quality evaluations.

Three plain dataclasses — :class:`Job`, :class:`JobArtifact`,
:class:`JobEvaluation` — matching the ``tasks`` / ``task_artifacts`` /
``task_evaluations`` tables. The store converts int-coded enum columns to
string names at the row↔entity boundary (see ``omnigent/db/enum_codecs.py``).
"""

from __future__ import annotations

from dataclasses import dataclass, field

# Job lifecycle states (mirror TASK_STATE int codes).
TASK_STATE_TODO = "todo"
TASK_STATE_IN_PROGRESS = "in_progress"
TASK_STATE_PENDING_REVIEW = "pending_review"
TASK_STATE_COMPLETED = "completed"
TASK_STATE_RETURNED = "returned"
TASK_STATE_BLOCKED = "blocked"

# Artifact types (mirror TASK_ARTIFACT_TYPE int codes).
ARTIFACT_TYPE_NONE = "none"
ARTIFACT_TYPE_FILE = "file"
ARTIFACT_TYPE_MESSAGE = "message"

# Evaluation actions (mirror TASK_EVALUATION_ACTION int codes).
EVALUATION_PASS = "pass"
EVALUATION_REJECT = "reject"


@dataclass
class JobEvaluation:
    """A product-quality verdict driving task flow."""

    id: str
    job_id: str
    action: str  # "pass" | "reject"
    created_at: int
    evaluator_user_id: str | None = None
    comment: str | None = None


@dataclass
class JobArtifact:
    """A product a task produced on completion (may be none)."""

    id: str
    job_id: str
    artifact_type: str  # "none" | "file" | "message"
    created_at: int
    ref: str | None = None
    summary: str | None = None


@dataclass
class Job:
    """A business task node in the outer collaboration job tree.

    :param id: Job id (uuid hex).
    :param title: Human-readable task name, e.g. "需求分析".
    :param state: Lifecycle state (todo / in_progress / pending_review /
        completed / returned / blocked).
    :param round: Round counter — 1 for first execution, incremented on each
        reject/redo.
    :param created_at: Unix epoch seconds at creation.
    :param parent_job_id: Parent task id; None for a root task.
    :param root_job_id: Root task id of the tree (itself when root).
    :param description: Free-text task description.
    :param assignee_user_id: Executor user, e.g. "zhangsan".
    :param created_by_user_id: Creator (e.g. the project manager).
    :param agent_name: Role/agent handling this task, e.g. "architect-agent".
    :param depends_on: Comma-separated task ids this task depends on.
    :param session_id: The inner session created to execute this task.
    :param updated_at: Unix epoch seconds of last write, or None.
    :param artifacts: Products this task produced (populated on read).
    :param evaluations: Quality evaluations on this task (populated on read).
    :param children: Child tasks in the tree (populated on tree read).
    """

    id: str
    title: str
    state: str = TASK_STATE_TODO
    round: int = 1
    created_at: int = 0
    parent_job_id: str | None = None
    root_job_id: str | None = None
    description: str | None = None
    assignee_user_id: str | None = None
    created_by_user_id: str | None = None
    agent_name: str | None = None
    depends_on: str | None = None
    session_id: str | None = None
    host_id: str | None = None
    updated_at: int | None = None
    artifacts: list[JobArtifact] = field(default_factory=list)
    evaluations: list[JobEvaluation] = field(default_factory=list)
    children: list["Job"] = field(default_factory=list)

    @property
    def is_leaf(self) -> bool:
        """Whether this task has no children."""
        return not self.children

    def path(self) -> str:
        """Compute the task-tree path code, e.g. ``T1-R1-t2``.

        Walks ancestors via the tree's parent links when available; falls back
        to a stable code derived from the id when the tree isn't loaded.
        """
        # With a fully loaded tree we could walk parent_job_id chain; for now
        # return a deterministic code based on the task position.
        parts: list[str] = []
        node: Job | None = self
        while node is not None:
            parts.append(f"t{node.round}" if node.parent_job_id else f"T{node.round}")
            node = node.parent if hasattr(node, "parent") and node.parent else None
        parts.reverse()
        return "-".join(parts)
