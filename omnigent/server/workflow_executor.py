"""通用 YAML 流程执行器（配置驱动，非硬编码）。

一个任务的工作流以 YAML 定义（workflow.steps：id/name/agent/depends_on/
auto_accept/auto_approve/...）。本模块负责：

- 解析 YAML（容忍 dict / JSON 字符串）
- 按 steps 生成任务树（主任务 + 子任务）
- 状态流转的动作钩子：claim / launch / complete / evaluate
  每步根据自身 config 决定行为（自动接受 / 自动审批 / 人工）
- 依赖检查与解锁提示

状态变更的最终权威仍是用户动作（claim/complete/evaluate）；
auto_accept / auto_approve 只是配置驱动的"自动执行该动作"，不是
系统凭空改状态。
"""

from __future__ import annotations

import json
import logging
from typing import Any

_logger = logging.getLogger("omnigent.server.workflow_executor")

# 会话最后消息空闲多少秒后允许提交（agent 完成判定）。
AGENT_IDLE_GATE_S = 30


def parse_workflow_config(raw: Any) -> dict[str, Any]:
    """Normalize a task's config into a dict with ``steps``.

    Accepts a dict (already parsed) or a JSON string. Returns
    ``{"steps": [...]}`` — empty steps when nothing resolvable.
    """
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except Exception:  # noqa: BLE001
            return {"steps": []}
    if not isinstance(raw, dict):
        return {"steps": []}
    wf = raw.get("workflow")
    steps = wf.get("steps") if isinstance(wf, dict) else None
    if steps is None:
        steps = raw.get("steps") or []
    if not isinstance(steps, list):
        steps = []
    return {"steps": steps}


def step_config(job: Any) -> dict[str, Any]:
    """Return the step dict for a job from its own config.

    A child job stores ITS OWN step dict ({"id","name","agent",
    "auto_accept","auto_approve",...}) as config; a root may carry the
    whole workflow ({"workflow":{"steps":[...]}}).
    """
    cfg = getattr(job, "config", None)
    if isinstance(cfg, str):
        try:
            cfg = json.loads(cfg)
        except Exception:  # noqa: BLE001
            cfg = None
    if isinstance(cfg, dict):
        # Single step dict (child): has id/name and possibly auto_* keys.
        if "name" in cfg and ("id" in cfg or "agent" in cfg):
            return cfg
        # Whole workflow: find the step matching this job's title (or id).
        wf = cfg.get("workflow")
        steps = wf.get("steps") if isinstance(wf, dict) else None
        if steps is None:
            steps = cfg.get("steps") or []
        title = getattr(job, "title", None)
        for st in steps:
            if st.get("name") == title or st.get("id") == title:
                return st
        # No matching step: a root task that merely CARRIES the workflow
        # (its children are the steps) must not inherit any step's flags —
        # e.g. auto_approve from steps[0] would auto-complete the root
        # without the project manager's manual acceptance.
        return {}
    return {}


def wants_auto_accept(job: Any) -> bool:
    """True when the step config declares ``auto_accept: true``."""
    return bool(step_config(job).get("auto_accept"))


def wants_auto_approve(job: Any) -> bool:
    """True when the step config declares ``auto_approve: true`` — the task
    completes automatically once the agent finishes (submit lands)."""
    return bool(step_config(job).get("auto_approve"))


def resolve_depends(job: Any, store: Any) -> list[Any]:
    """Resolve a job's depends_on (comma-separated job ids) to jobs."""
    dep = getattr(job, "depends_on", None)
    if not dep:
        return []
    ids = [d.strip() for d in str(dep).split(",") if d.strip()]
    result: list[Any] = []
    for did in ids:
        j = store.get(did)
        if j is not None:
            result.append(j)
    return result


def dependencies_done(job: Any, store: Any) -> tuple[bool, str | None]:
    """Return (all_done, blocking_title). Used by claim/launch gates."""
    for dep in resolve_depends(job, store):
        if dep.state != "completed":
            return False, dep.title
    return True, None
