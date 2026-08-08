import { useCallback, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BriefcaseIcon,
  CheckCircle2Icon,
  CircleIcon,
  CircleDotIcon,
  FolderIcon,
  GitBranchIcon,
  LockIcon,
  PlusIcon,
  RefreshCwIcon,
  ServerIcon,
  ShieldIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
  XIcon,
} from "lucide-react";
import { authenticatedFetch, getCurrentIsAdmin, getCurrentUserId } from "@/lib/identity";
import { L } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/** Wire shapes. */
interface JobWire {
  id: string;
  title: string;
  state: string;
  round: number;
  parent_job_id?: string | null;
  root_job_id?: string | null;
  description?: string | null;
  assignee_user_id?: string | null;
  created_by_user_id?: string | null;
  agent_name?: string | null;
  session_id?: string | null;
  host_id?: string | null;
  require_approval?: boolean;
  created_at?: number;
  artifacts?: { id: string; artifact_type: string; ref?: string | null; summary?: string | null }[];
  evaluations?: { id: string; action: string; evaluator_user_id?: string | null; comment?: string | null }[];
  children?: JobWire[];
}

interface ProjectWire {
  id: string;
  name: string;
  kind: string;
  owner_user_id?: string | null;
  config?: Record<string, unknown>;
  members?: { user_id: string; role: number }[];
}

interface JobStatsWire {
  total_jobs?: number;
  by_state?: Record<string, number>;
  total_rounds?: number;
  total_rejects?: number;
  root_count?: number;
}

interface HostWire {
  host_id: string;
  name: string;
  status: string;
  owner?: string;
}

const STATE_LABELS: Record<string, string> = {
  todo: "待办",
  in_progress: "进行中",
  in_review: "待验收",
  completed: "已完成",
  returned: "返工",
  
};

const STATE_COLORS: Record<string, string> = {
  todo: "bg-slate-100 text-slate-700",
  in_progress: "bg-blue-100 text-blue-700",
  in_review: "bg-amber-100 text-amber-700",
  completed: "bg-green-100 text-green-700",
  returned: "bg-red-100 text-red-700",
  
};

/** 列头状态色（色条 + 文字） */
const COLUMN_HEADER_COLORS: Record<string, string> = {
  todo: "text-slate-700 border-slate-300",
  in_progress: "text-blue-700 border-blue-400",
  in_review: "text-amber-700 border-amber-400",
  completed: "text-green-700 border-green-500",
  returned: "text-red-700 border-red-400",
  
};

const COLUMN_BG: Record<string, string> = {
  todo: "bg-slate-50/60",
  in_progress: "bg-blue-50/40",
  in_review: "bg-amber-50/40",
  completed: "bg-green-50/40",
  returned: "bg-red-50/40",
  
};

function StateBadge({ state }: { state: string }) {
  const label = STATE_LABELS[state] ?? state;
  const color = STATE_COLORS[state] ?? "bg-slate-100";
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${color}`}>
      {label}
    </span>
  );
}

function StateIcon({ state }: { state: string }) {
  if (state === "completed") return <CheckCircle2Icon className="size-4 text-green-500" />;
  if (state === "in_progress") return <CircleDotIcon className="size-4 text-blue-500" />;
  if (state === "in_review") return <ThumbsUpIcon className="size-4 text-amber-500" />;
  if (state === "returned") return <ThumbsDownIcon className="size-4 text-red-500" />;
  return <CircleIcon className="size-4 text-muted-foreground" />;
}

/** Create-team-project dialog: name + members + flow phases. */
function CreateProjectForm({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState("");
  // Members picked from the user/host list (participant pool).
  const [selectedMembers, setSelectedMembers] = useState<string[]>([]);
  // Task workflow YAML (industry-standard steps; users edit directly).
  const [workflowYaml, setWorkflowYaml] = useState(
    "workflow:\n  steps:\n    - id: requirement\n      name: 需求分析\n      agent: zhangsan-agent\n    - id: architecture\n      name: 架构设计\n      agent: wangwu-agent\n    - id: backend\n      name: 后端开发\n      agent: zhaoliu-agent\n    - id: frontend\n      name: 前端开发\n      agent: lisi-agent\n    - id: test\n      name: 测试验证\n      agent: admin-agent",
  );
  const {
    data: memberOptions = [],
  } = useQuery({
    queryKey: ["member-options"],
    queryFn: async () => {
      // Host owners = people with machines who can execute; fall back
      // to the user list when hosts are empty.
      const hostsRes = await authenticatedFetch("/v1/hosts");
      const hosts = hostsRes.ok ? (await hostsRes.json() as { hosts: { owner?: string }[] }).hosts ?? [] : [];
      const owners = [...new Set(hosts.map((h) => h.owner).filter(Boolean))];
      if (owners.length > 0) return owners as string[];
      const usersRes = await authenticatedFetch("/v1/users");
      if (!usersRes.ok) return [];
      const users = (await usersRes.json()) as { users?: { id: string }[] };
      return (users.users ?? []).map((u) => u.id);
    },
    staleTime: 30_000,
  });
  // Member agent options (name → owner) for the workflow agent picker.
  const {
    data: agentOptions = [],
  } = useQuery({
    queryKey: ["member-agents"],
    queryFn: async () => {
      const res = await authenticatedFetch("/v1/agents");
      if (!res.ok) return [];
      const body = (await res.json()) as { data: { name: string; owner_user_id?: string | null }[] };
      return body.data ?? [];
    },
    staleTime: 30_000,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const members = selectedMembers;
      // Parse the YAML steps into config.workflow.steps (industry standard).
      const steps: { id: string; name: string; agent?: string }[] = [];
      let cur: { id: string; name: string; agent?: string } | null = null;
      for (const line of workflowYaml.split("\n")) {
        const t = line.trim();
        if (!t || t.startsWith("#")) continue;
        if (/^- id:/.test(t)) {
          if (cur) steps.push(cur);
          cur = { id: t.replace(/^- id:\s*/, "").trim(), name: "" };
        } else if (cur) {
          const m = t.match(/^(\w+):\s*(.*)$/);
          if (m) {
            if (m[1] === "name") cur.name = m[2].trim();
            else if (m[1] === "agent") cur.agent = m[2].trim();
          }
        }
      }
      if (cur) steps.push(cur);
      const res = await authenticatedFetch("/v1/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          kind: "team",
          config: { workflow: { steps } },
        }),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      const project = (await res.json()) as ProjectWire;
      // 添加成员
      for (const m of members) {
        await authenticatedFetch(`/v1/projects/${project.id}/members`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ user_id: m, role: 1 }),
        });
      }
      await queryClient.invalidateQueries({ queryKey: ["projects-mine"] });
      await queryClient.invalidateQueries({ queryKey: ["jobs"] });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [name, selectedMembers, workflowYaml, onDone, queryClient]);

  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">{L("New team project")}</span>
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>
          <XIcon className="size-3.5" />
        </Button>
      </div>
      <label className="space-y-1">
        <span className="text-sm">{L("Project name")}</span>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="电商平台" />
      </label>

      {/* 项目成员（参与者池，从 host 查询勾选） */}
      <label className="space-y-1">
        <span className="text-sm">{L("Members")}</span>
        <div className="flex flex-wrap gap-2">
          {memberOptions.length === 0 && (
            <span className="text-xs text-muted-foreground">{L("Loading…")}</span>
          )}
          {memberOptions.map((m) => (
            <label key={m} className="flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs">
              <input
                type="checkbox"
                className="size-3.5 accent-primary"
                checked={selectedMembers.includes(m)}
                onChange={(e) => {
                  setSelectedMembers((prev) =>
                    e.target.checked ? [...prev, m] : prev.filter((x) => x !== m),
                  );
                }}
              />
              {m}
            </label>
          ))}
        </div>
        <p className="text-[11px] text-muted-foreground">
          {L("Members")}: {selectedMembers.join(", ") || "—"}
        </p>
      </label>

      {/* 任务工作流 YAML（用户直接编辑 steps） */}
      <div className="space-y-1">
        <span className="text-sm">{L("Workflow YAML")}</span>
        <textarea
          value={workflowYaml}
          onChange={(e) => setWorkflowYaml(e.target.value)}
          spellCheck={false}
          className="h-44 w-full resize-y rounded-md border bg-muted/30 p-2 font-mono text-[11px] leading-relaxed"
        />
        <p className="text-[11px] text-muted-foreground">
          steps: id(唯一) + name(显示) + agent(绑定成员/主机)；任务页按此生成任务树
        </p>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex justify-end">
        <Button type="button" size="sm" disabled={saving || !name.trim()} onClick={save}>
          {saving ? L("Saving…") : L("Create")}
        </Button>
      </div>
    </Card>
  );
}

/** Create-job dialog. */
function CreateJobForm({ projectId, onDone }: { projectId?: string; onDone: () => void }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [agentName, setAgentName] = useState("");
  const [assignee, setAssignee] = useState("");
  const [parentId, setParentId] = useState("");
  const [requireApproval, setRequireApproval] = useState(false);
  // Task-level workflow (industry-standard steps: unique id + display name
  // + agent + depends_on referencing step ids) and work-team selection.
  const [steps, setSteps] = useState<{ id: string; name: string; agent: string; depends_on: string }[]>([
    { id: "requirement", name: "需求分析", agent: "zhangsan-agent", depends_on: "" },
  ]);
  const [team, setTeam] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const { data: agentOptions = [] } = useQuery({
    queryKey: ["agents", "member"],
    queryFn: async () => {
      const res = await authenticatedFetch("/v1/agents");
      if (!res.ok) throw new Error(`${res.status}`);
      const body = (await res.json()) as { data: { name: string; owner_user_id?: string | null }[] };
      return (body.data ?? []).filter((a) => a.owner_user_id);
    },
    staleTime: 30_000,
  });
  const { data: projects = [] } = useQuery({
    queryKey: ["projects-mine"],
    queryFn: async () => {
      const res = await authenticatedFetch("/v1/projects");
      if (!res.ok) throw new Error(`${res.status}`);
      const body = (await res.json()) as { data: ProjectWire[] };
      return body.data ?? [];
    },
    staleTime: 30_000,
  });
  const activeProject = projects.find((p) => p.id === projectId) ?? null;
  const projectMembers = activeProject?.members ?? [];

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const payload: Record<string, unknown> = { title: title.trim() };
      if (description.trim()) payload.description = description.trim();
      if (agentName.trim()) payload.agent_name = agentName.trim();
      if (assignee.trim()) payload.assignee_user_id = assignee.trim();
      if (parentId.trim()) payload.parent_job_id = parentId.trim();
      if (requireApproval) payload.require_approval = true;
      if (projectId) payload.project_id = projectId;
      // Task workflow YAML: config.workflow.steps (industry standard).
      const cleanSteps = steps
        .map((st) => ({
          id: st.id.trim(),
          name: st.name.trim() || st.id.trim(),
          ...(st.agent.trim() ? { agent: st.agent.trim() } : {}),
          ...(st.depends_on.trim()
            ? { depends_on: st.depends_on.split(",").map((x) => x.trim()).filter(Boolean) }
            : {}),
        }))
        .filter((st) => st.id);
      if (cleanSteps.length > 0) {
        payload.config = { workflow: { steps: cleanSteps } };
      }
      const res = await authenticatedFetch("/v1/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      // Add the task's work-team members (subset of the project team).
      if (projectId && team.size > 0) {
        const jid = ((await res.clone().json()) as { job: { id: string } }).job.id;
        for (const uid of team) {
          await authenticatedFetch(`/v1/jobs/${jid}/members`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ user_id: uid }),
          });
        }
      }
      await queryClient.invalidateQueries({ queryKey: ["jobs"] });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [title, description, agentName, assignee, parentId, requireApproval, projectId, steps, team, onDone, queryClient]);

  const updateStep = (i: number, field: string, value: string) =>
    setSteps((prev) => prev.map((st, idx) => (idx === i ? { ...st, [field]: value } : st)));

  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">{L("New job")}</span>
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>
          <XIcon className="size-3.5" />
        </Button>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="space-y-1">
          <span className="text-sm">{L("Title")}</span>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="需求分析" />
        </label>
        <label className="space-y-1">
          <span className="text-sm">{L("Agent")}</span>
          <Input value={agentName} onChange={(e) => setAgentName(e.target.value)} placeholder="architect-agent" />
        </label>
        <label className="space-y-1">
          <span className="text-sm">{L("Assignee")}</span>
          <Input value={assignee} onChange={(e) => setAssignee(e.target.value)} placeholder="zhangsan" />
        </label>
        <label className="space-y-1">
          <span className="text-sm">{L("Parent job")}</span>
          <Input value={parentId} onChange={(e) => setParentId(e.target.value)} placeholder="(root)" />
        </label>
        <label className="space-y-1 sm:col-span-2">
          <span className="text-sm">{L("Description")}</span>
          <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="任务描述" />
        </label>
        <label className="flex items-center gap-2 sm:col-span-2">
          <input
            type="checkbox"
            checked={requireApproval}
            onChange={(e) => setRequireApproval(e.target.checked)}
            className="size-4 accent-primary"
          />
          <span className="text-sm">{L("Require approval before execution")}</span>
        </label>
      </div>

      {/* 工作团队：从项目成员选择 */}
      {projectMembers.length > 0 && (
        <div className="space-y-1.5 border-t pt-2">
          <span className="text-sm font-medium">{L("Work team")}</span>
          <div className="flex flex-wrap gap-2">
            {projectMembers.map((m) => (
              <label key={m.user_id} className="flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 text-xs hover:bg-muted">
                <input
                  type="checkbox"
                  checked={team.has(m.user_id)}
                  onChange={(e) =>
                    setTeam((prev) => {
                      const next = new Set(prev);
                      if (e.target.checked) next.add(m.user_id);
                      else next.delete(m.user_id);
                      return next;
                    })
                  }
                  className="size-3.5 accent-primary"
                />
                {m.user_id}
              </label>
            ))}
          </div>
        </div>
      )}

      {/* 工作流 steps 编辑器 */}
      <div className="space-y-1.5 border-t pt-2">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">{L("Workflow steps")}</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() =>
              setSteps((prev) => [...prev, { id: "", name: "", agent: "", depends_on: "" }])
            }
          >
            <PlusIcon className="size-3" /> {L("Add step")}
          </Button>
        </div>
        {steps.map((st, i) => (
          <div key={i} className="grid grid-cols-[1fr_1.2fr_1.2fr_1.4fr_auto] items-center gap-1.5">
            <Input value={st.id} onChange={(e) => updateStep(i, "id", e.target.value)} placeholder="id" className="h-7 text-xs" />
            <Input value={st.name} onChange={(e) => updateStep(i, "name", e.target.value)} placeholder="名称" className="h-7 text-xs" />
            <select
              value={st.agent}
              onChange={(e) => updateStep(i, "agent", e.target.value)}
              className="h-7 rounded-md border bg-background px-1.5 text-xs"
            >
              <option value="">agent…</option>
              {agentOptions.map((a) => (
                <option key={a.name} value={a.name}>
                  {a.name} ({a.owner_user_id})
                </option>
              ))}
            </select>
            <Input value={st.depends_on} onChange={(e) => updateStep(i, "depends_on", e.target.value)} placeholder="depends_on (step id)" className="h-7 text-xs" />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-1.5 text-xs"
              onClick={() => setSteps((prev) => prev.filter((_, idx) => idx !== i))}
            >
              <XIcon className="size-3" />
            </Button>
          </div>
        ))}
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex justify-end">
        <Button type="button" size="sm" disabled={saving || !title.trim()} onClick={save}>
          {saving ? L("Saving…") : L("Create")}
        </Button>
      </div>
    </Card>
  );
}

/** Evaluate dialog for a pending job. */
function EvaluateForm({ job, onDone }: { job: JobWire; onDone: () => void }) {
  const [comment, setComment] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const evaluate = useCallback(
    async (action: "pass" | "reject") => {
      setSaving(true);
      setError(null);
      try {
        const res = await authenticatedFetch(`/v1/jobs/${job.id}/evaluate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, comment: comment.trim() || undefined }),
        });
        if (!res.ok) throw new Error(`${res.status}`);
        await queryClient.invalidateQueries({ queryKey: ["jobs"] });
        onDone();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setSaving(false);
      }
    },
    [job.id, comment, onDone, queryClient],
  );

  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">{L("Evaluate job")} · {job.title}</span>
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>
          <XIcon className="size-3.5" />
        </Button>
      </div>
      <label className="space-y-1">
        <span className="text-sm">{L("Comment")}</span>
        <Input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="质量意见（可选）" />
      </label>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={saving}
          onClick={() => evaluate("reject")}
          className="text-red-600"
        >
          <ThumbsDownIcon className="size-3.5" /> {L("Reject")}
        </Button>
        <Button type="button" size="sm" disabled={saving} onClick={() => evaluate("pass")}>
          <ThumbsUpIcon className="size-3.5" /> {L("Approve")}
        </Button>
      </div>
    </Card>
  );
}

/** Launch dialog — pick an online host from the fleet. */
function LaunchForm({ job, onDone }: { job: JobWire; onDone: () => void }) {
  const [hostId, setHostId] = useState("");
  const [workspace, setWorkspace] = useState("/workspace");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const {
    data: hosts = [],
    isLoading: hostsLoading,
  } = useQuery({
    queryKey: ["hosts"],
    queryFn: async () => {
      const res = await authenticatedFetch("/v1/hosts");
      if (!res.ok) throw new Error(`${res.status}`);
      const body = (await res.json()) as { hosts: HostWire[] };
      return body.hosts;
    },
    staleTime: 15_000,
  });
  const online = hosts.filter((h) => h.status === "online");

  const launch = useCallback(async () => {
    if (!hostId) return;
    setSaving(true);
    setError(null);
    try {
      const res = await authenticatedFetch(`/v1/jobs/${job.id}/launch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ host_id: hostId, workspace }),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      await queryClient.invalidateQueries({ queryKey: ["jobs"] });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [hostId, workspace, job.id, onDone, queryClient]);

  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">
          {L("Launch")} · {job.title}
        </span>
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>
          <XIcon className="size-3.5" />
        </Button>
      </div>
      <label className="space-y-1">
        <span className="text-sm">{L("Host")}</span>
        {hostsLoading ? (
          <div className="text-xs text-muted-foreground">{L("Loading…")}</div>
        ) : online.length === 0 ? (
          <div className="text-xs text-destructive">{L("No online hosts")}</div>
        ) : (
          <Select value={hostId} onValueChange={setHostId}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder={L("Select a host…")} />
            </SelectTrigger>
            <SelectContent>
              {online.map((h) => (
                <SelectItem key={h.host_id} value={h.host_id}>
                  <span className="flex items-center gap-2">
                    <ServerIcon className="size-3.5" />
                    {h.name}
                    {h.owner && h.owner !== "local" && (
                      <span className="text-xs text-muted-foreground">({h.owner})</span>
                    )}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </label>
      <label className="space-y-1">
        <span className="text-sm">{L("Workspace")}</span>
        <Input value={workspace} onChange={(e) => setWorkspace(e.target.value)} placeholder="/workspace" />
      </label>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex justify-end">
        <Button type="button" size="sm" disabled={saving || !hostId} onClick={launch}>
          <GitBranchIcon className="size-3.5" /> {saving ? L("Launching…") : L("Launch")}
        </Button>
      </div>
    </Card>
  );
}

/** One executable job card in the board (leaf tasks only — roots live
 *  in the left tree nav). */
function JobNode({
  job,
  currentUserId,
  isAdmin,
  rootTitle,
  highlighted,
}: {
  job: JobWire;
  currentUserId: string | null;
  isAdmin: boolean;
  /** Title of the root (main task) this job belongs to, shown as a
   *  breadcrumb on the card so the board identifies the owning tree. */
  rootTitle?: string | null;
  highlighted?: boolean;
}) {
  const [showEvaluate, setShowEvaluate] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [showLaunch, setShowLaunch] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const queryClient = useQueryClient();

  const claim = useCallback(async () => {
    await authenticatedFetch(`/v1/jobs/${job.id}/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    await queryClient.invalidateQueries({ queryKey: ["jobs"] });
  }, [job.id, queryClient]);

  const submit = useCallback(async () => {
    const res = await authenticatedFetch(`/v1/jobs/${job.id}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (!res.ok) alert(`Submit failed: ${res.status}`);
    await queryClient.invalidateQueries({ queryKey: ["jobs"] });
  }, [job.id, queryClient]);

  const approveExecution = useCallback(async () => {
    const res = await authenticatedFetch(`/v1/jobs/${job.id}/approve-execution`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    if (!res.ok) alert(`${res.status}`);
    await queryClient.invalidateQueries({ queryKey: ["jobs"] });
  }, [job.id, queryClient]);

  const hasDetail = (job.artifacts?.length ?? 0) > 0 || (job.evaluations?.length ?? 0) > 0;

  return (
    <div>
      <Card
        className={`group relative overflow-hidden p-3 transition-shadow hover:shadow-md ${
          highlighted ? "ring-2 ring-blue-500 shadow-lg" : ""
        }`}
      >
        {/* 顶部状态色条 */}
        <div className={`absolute inset-x-0 top-0 h-0.5 ${STATE_COLORS[job.state].split(" ")[0]}`} />

        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-start gap-2">
            <StateIcon state={job.state} />
            <div className="min-w-0">
              {rootTitle && rootTitle !== job.title && (
                <div className="mb-0.5 flex items-center gap-1 text-[10px] text-muted-foreground/70">
                  <span className="inline-flex items-center gap-0.5 rounded bg-muted/60 px-1 py-px">
                    <FolderIcon className="size-2.5" />
                    {rootTitle}
                  </span>
                  <span aria-hidden>›</span>
                </div>
              )}
              <div className="flex items-center gap-1.5">
                <span className="truncate text-sm font-semibold">{job.title}</span>
                {job.round > 1 && (
                  <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[10px] font-medium text-muted-foreground">
                    R{job.round}
                  </span>
                )}
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
                {job.agent_name && (
                  <span className="inline-flex items-center gap-1">
                    <BriefcaseIcon className="size-3" />
                    {job.agent_name}
                  </span>
                )}
                {job.assignee_user_id && (
                  <span className="inline-flex items-center gap-1">
                    <span className="text-muted-foreground/60">→</span>
                    {job.assignee_user_id}
                  </span>
                )}
                {job.host_id && (
                  <span className="inline-flex items-center gap-1">
                    <ServerIcon className="size-3" />
                    {job.host_id.slice(0, 8)}
                  </span>
                )}
                {job.require_approval && (
                  <span className="inline-flex items-center gap-1 text-amber-600">
                    <ShieldIcon className="size-3" />
                    {L("Awaiting approval")}
                  </span>
                )}
                {job.depends_on && job.state === "todo" && (
                  <span className="inline-flex items-center gap-1 text-slate-500">
                    <LockIcon className="size-3" />
                    {L("Awaiting dependency")}
                  </span>
                )}
                {job.session_id && (
                  <a
                    href={`/c/${job.session_id}`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-blue-600 hover:underline"
                  >
                    <GitBranchIcon className="size-3" />
                    {L("View session")}
                  </a>
                )}
              </div>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-0.5">
            {job.state === "todo" && (isAdmin || job.assignee_user_id === currentUserId) && (
              <Button type="button" variant="outline" size="sm" className="h-6 px-2 text-xs" onClick={claim}>
                {L("Claim")}
              </Button>
            )}
            {job.state === "in_progress" && !job.session_id && (isAdmin || job.assignee_user_id === currentUserId) && (
              <Button type="button" variant="outline" size="sm" className="h-6 px-2 text-xs" onClick={() => setShowLaunch(true)}>
                <GitBranchIcon className="size-3" /> {L("Launch")}
              </Button>
            )}
            {job.state === "in_progress" && job.session_id && (isAdmin || job.assignee_user_id === currentUserId) && (
              <Button type="button" variant="outline" size="sm" className="h-6 px-2 text-xs text-green-600" onClick={submit}>
                <CheckCircle2Icon className="size-3" /> {L("Submit")}
              </Button>
            )}
            {job.state === "in_review" && isAdmin && (
              <Button type="button" variant="outline" size="sm" className="h-6 px-2 text-xs" onClick={() => setShowEvaluate(true)}>
                <ThumbsUpIcon className="size-3" /> {L("Evaluate")}
              </Button>
            )}
            {job.require_approval && (isAdmin || job.assignee_user_id === currentUserId) && (
              <Button type="button" variant="outline" size="sm" className="h-6 px-2 text-xs text-green-600" onClick={approveExecution}>
                <ShieldIcon className="size-3" /> {L("Approve execution")}
              </Button>
            )}
            {hasDetail && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 px-1.5 text-xs"
                onClick={() => setExpanded((v) => !v)}
                aria-label="details"
              >
                {expanded ? "−" : "+"}
              </Button>
            )}
          </div>
        </div>

        {/* 产物/评价详情 */}
        {expanded && (
          <div className="mt-2 space-y-1.5 border-t pt-2 text-[11px]">
            {job.artifacts && job.artifacts.length > 0 && (
              <div className="space-y-1">
                {job.artifacts.map((a) => (
                  <div key={a.id} className="flex gap-1.5 text-muted-foreground">
                    <span className="shrink-0 font-medium">📄</span>
                    <span className="line-clamp-2">{a.summary ?? a.ref}</span>
                  </div>
                ))}
              </div>
            )}
            {job.evaluations && job.evaluations.length > 0 && (
              <div className="space-y-1">
                {job.evaluations.map((e) => (
                  <div key={e.id} className="flex gap-1.5">
                    <span className="shrink-0">{e.action === "pass" ? "✅" : "❌"}</span>
                    <span className="text-muted-foreground">
                      <span className="font-medium">{e.evaluator_user_id ?? "?"}</span>
                      {e.comment ? `: ${e.comment}` : ""}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

      </Card>

      {showLaunch && (
        <div className="mt-1">
          <LaunchForm job={job} onDone={() => setShowLaunch(false)} />
        </div>
      )}
      {showEvaluate && (
        <div className="mt-1">
          <EvaluateForm job={job} onDone={() => setShowEvaluate(false)} />
        </div>
      )}
      {showCreate && (
        <div className="mt-1">
          <CreateJobForm
            projectId={projectId}
            onDone={() => {
              setShowCreate(false);
              queryClient.invalidateQueries({ queryKey: ["jobs"] });
            }}
          />
        </div>
      )}
    </div>
  );
}

/**
 * Job list page (/jobs) — the outer collaboration task tree.
 *
 * Project managers create and assign jobs; executors claim + launch them
 * (spawning a session on their own host); reviewers evaluate the produced
 * artifacts (approve → next stage, reject → redo with round+1).
 */


/** Left nav: every task tree under the project (a project can have
 *  several main tasks). Each root shows its progress bar; clicking a
 *  node highlights the matching card in the board. */
function TaskTree({
  jobs,
  activeJobId,
  onSelect,
}: {
  jobs: JobWire[];
  activeJobId: string | null;
  onSelect: (id: string) => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const renderNode = (job: JobWire, depth: number) => {
    const children = job.children ?? [];
    const isRoot = !job.parent_job_id;
    const doneCount = children.filter((c) => c.state === "completed").length;
    const progress = children.length > 0 ? Math.round((doneCount / children.length) * 100) : 0;
    const isCollapsed = collapsed.has(job.id);
    const isActive = activeJobId === job.id;
    return (
      <div key={job.id}>
        <button
          type="button"
          onClick={() => onSelect(job.id)}
          className={`flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs transition-colors ${
            isActive
              ? "bg-blue-100 font-semibold text-blue-700"
              : "text-foreground hover:bg-muted"
          }`}
          style={{ paddingLeft: `${8 + depth * 14}px` }}
        >
          <span
            role="button"
            tabIndex={-1}
            onClick={(e) => {
              e.stopPropagation();
              toggle(job.id);
            }}
            className="flex size-4 shrink-0 items-center justify-center text-muted-foreground"
          >
            {children.length > 0 ? (isCollapsed ? "▸" : "▾") : "•"}
          </span>
          {isRoot && <BriefcaseIcon className="size-3 shrink-0 text-blue-600" />}
          <span className="min-w-0 flex-1 truncate">{job.title}</span>
          {job.state === "completed" && (
            <CheckCircle2Icon className="size-3 shrink-0 text-green-600" />
          )}
          {job.state === "in_progress" && (
            <CircleDotIcon className="size-3 shrink-0 text-amber-500" />
          )}
          {job.state === "pending_review" && (
            <ThumbsUpIcon className="size-3 shrink-0 text-amber-500" />
          )}
          {job.state === "returned" && (
            <ThumbsDownIcon className="size-3 shrink-0 text-red-500" />
          )}
        </button>
        {isRoot && children.length > 0 && (
          <div className="mb-1 ml-6 mt-0.5 h-1 w-16 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-green-500 transition-all"
              style={{ width: `${progress}%` }}
            />
          </div>
        )}
        {!isCollapsed && children.length > 0 && (
          <div>{children.map((c) => renderNode(c, depth + 1))}</div>
        )}
      </div>
    );
  };

  return (
    <div className="rounded-xl border bg-background p-2">
      <div className="px-2 pb-1 pt-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {L("Task tree")}
      </div>
      <div className="space-y-0.5">{jobs.map((j) => renderNode(j, 0))}</div>
    </div>
  );
}

export function JobsPage() {
  const [refreshKey, setRefreshKey] = useState(0);
  // Create form is open by default so the page always offers a visible,
  // click-free path to make a task (some browsers had stale tab issues
  // where the toggle felt unresponsive).
  const [showCreate, setShowCreate] = useState(false);
  const [showCreateProject, setShowCreateProject] = useState(false);
  // Team-project filter: when set, the board shows that project's tasks
  // (scope=project) and the header shows project info + flow progress.
  const [projectId, setProjectId] = useState<string>("");
  // Board highlight: id of the card the user clicked in the left tree.
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const currentUserId = getCurrentUserId();
  const isAdmin = getCurrentIsAdmin();
  const {
    data: projects = [],
  } = useQuery({
    queryKey: ["projects-mine"],
    queryFn: async () => {
      const res = await authenticatedFetch("/v1/projects");
      if (!res.ok) throw new Error(`${res.status}`);
      const body = (await res.json()) as { data: ProjectWire[] };
      return body.data ?? [];
    },
    staleTime: 30_000,
  });
  const teamProjects = projects.filter((p) => p.kind === "team");
  const activeProject = teamProjects.find((p) => p.id === projectId) ?? null;
  const {
    data: jobs = [],
    isLoading,
    error,
  } = useQuery({
    queryKey: ["jobs", refreshKey, projectId],
    queryFn: async () => {
      const url = projectId
        ? `/v1/jobs?scope=project&project_id=${projectId}`
        : "/v1/jobs";
      const res = await authenticatedFetch(url);
      if (!res.ok) throw new Error(`${res.status}`);
      const body = (await res.json()) as { jobs: JobWire[] };
      return body.jobs;
    },
    staleTime: 10_000,
  });
  const {
    data: stats,
  } = useQuery({
    queryKey: ["jobs-stats", refreshKey],
    queryFn: async () => {
      const res = await authenticatedFetch("/v1/jobs/stats");
      if (!res.ok) throw new Error(`${res.status}`);
      return (await res.json()) as JobStatsWire;
    },
    staleTime: 10_000,
  });

  const byState = useMemo(() => stats?.by_state ?? {}, [stats]);

  // ── 多列看板：按状态分列 ──
  const COLUMNS: { state: string; label: string }[] = [
    { state: "todo", label: STATE_LABELS.todo },
    { state: "in_progress", label: STATE_LABELS.in_progress },
    { state: "in_review", label: STATE_LABELS.in_review },
    { state: "completed", label: STATE_LABELS.completed },
    { state: "returned", label: STATE_LABELS.returned },
  ];

  // Map each job id → its root (main task) title so board cards show a
  // breadcrumb identifying which tree they belong to.
  const rootTitleById = useMemo(() => {
    const m = new Map<string, string>();
    const walk = (list: JobWire[]) => {
      for (const j of list) {
        const children = j.children ?? [];
        if (children.length > 0) {
          for (const c of children) m.set(c.id, j.title);
          walk(children);
        }
      }
    };
    walk(jobs);
    return m;
  }, [jobs]);

  const board = useMemo(() => {
    const byCol = new Map<string, JobWire[]>();
    for (const col of COLUMNS) byCol.set(col.state, []);
    // The board holds EXECUTABLE tasks only (children). Roots (main
    // tasks) are aggregate containers and live in the left task tree.
    const flatten = (list: JobWire[]) => {
      for (const j of list) {
        if (j.parent_job_id) {
          const col = byCol.get(j.state);
          if (col) col.push(j);
        }
        if (j.children && j.children.length > 0) flatten(j.children);
      }
    };
    flatten(jobs);
    for (const col of byCol.values()) {
      col.sort((a, b) => b.round - a.round || (b.created_at ?? 0) - (a.created_at ?? 0));
    }
    return byCol;
  }, [jobs]);

  return (
    <section className="h-full overflow-y-auto px-4 pb-4 pt-16">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <BriefcaseIcon className="size-6" /> {L("Jobs")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {L("Business tasks: assign, execute, evaluate.")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => setRefreshKey((k) => k + 1)}>
            <RefreshCwIcon className="size-3.5" /> {L("Refresh")}
          </Button>
        </div>
      </div>

      {/* 项目选择 + 流程进度 */}
      {teamProjects.length > 0 && (
        <div className="mt-4 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{L("Project")}</span>
            <Select value={projectId} onValueChange={setProjectId}>
              <SelectTrigger className="w-56">
                <SelectValue placeholder={L("All tasks")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">{L("All tasks")}</SelectItem>
                {teamProjects.map((p) => (
                  <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {activeProject && (
              <Badge variant="outline" className="gap-1">
                <BriefcaseIcon className="size-3" />
                {L("Team project")}
              </Badge>
            )}
          </div>
          {activeProject && (
            <Card className="p-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-semibold">{activeProject.name}</div>
                  {activeProject.owner_user_id && (
                    <div className="mt-1 flex items-center gap-1.5 text-xs">
                      <span className="rounded-full bg-blue-100 px-2 py-0.5 font-medium text-blue-700">
                        {L("Project manager")}: {activeProject.owner_user_id}
                      </span>
                    </div>
                  )}
                  {activeProject.members && activeProject.members.length > 0 && (
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                      {activeProject.members.map((m) => (
                        <span key={m.user_id} className="rounded-full bg-muted px-2 py-0.5">
                          {m.user_id}{m.role === 2 ? " · " + L("admin") : ""}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                {(() => {
                  const phases = (activeProject.config?.phases as { name: string }[] | undefined) ?? [];
                  if (phases.length === 0) return null;
                  const doneTitles = new Set(
                    jobs.filter((j) => j.state === "completed").map((j) => j.title),
                  );
                  const current = phases.findIndex((ph) => !doneTitles.has(ph.name));
                  const progress = current === -1 ? phases.length : current;
                  return (
                    <div className="min-w-0 flex-1">
                      <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
                        <span>{L("Flow progress")}</span>
                        <span>{progress}/{phases.length}</span>
                      </div>
                      <div className="flex gap-1">
                        {phases.map((ph, i) => (
                          <div
                            key={ph.name}
                            className={`h-1.5 flex-1 rounded-full ${
                              i < progress
                                ? "bg-green-500"
                                : i === current
                                  ? "bg-amber-400"
                                  : "bg-muted"
                            }`}
                            title={ph.name}
                          />
                        ))}
                      </div>
                      <div className="mt-1 truncate text-xs text-muted-foreground">
                        {current === -1
                          ? L("All phases complete")
                          : `${phases[current].name} · ${L("in progress")}`}
                      </div>
                    </div>
                  );
                })()}
              </div>
            </Card>
          )}
        </div>
      )}

      {/* Stats bar */}
      <div className="mt-4 grid gap-2 sm:grid-cols-5">
        <Card className="p-3 text-center">
          <div className="text-xl font-semibold">{stats?.total_jobs ?? 0}</div>
          <div className="text-xs text-muted-foreground">{L("Total jobs")}</div>
        </Card>
        <Card className="p-3 text-center">
          <div className="text-xl font-semibold">{stats?.root_count ?? 0}</div>
          <div className="text-xs text-muted-foreground">{L("Root projects")}</div>
        </Card>
        <Card className="p-3 text-center">
          <div className="text-xl font-semibold">{stats?.total_rounds ?? 0}</div>
          <div className="text-xs text-muted-foreground">{L("Total rounds")}</div>
        </Card>
        <Card className="p-3 text-center">
          <div className="text-xl font-semibold text-red-600">{stats?.total_rejects ?? 0}</div>
          <div className="text-xs text-muted-foreground">{L("Rejects")}</div>
        </Card>
        <Card className="p-3 text-center">
          <div className="text-xl font-semibold">{byState.completed ?? 0}</div>
          <div className="text-xs text-muted-foreground">{L("Completed")}</div>
        </Card>
      </div>



      {isLoading && <p className="mt-4 text-sm text-muted-foreground">{L("Loading…")}</p>}
      {error && (
        <p className="mt-4 text-sm text-destructive">
          {L("Failed to load:")} {String(error)}
        </p>
      )}
      {!isLoading && !error && jobs.length === 0 && (
        <p className="mt-4 text-sm text-muted-foreground">{L("No jobs yet. Create one to start.")}</p>
      )}

      {/* 选中项目：左侧任务树 + 右侧状态看板 */}
      {!isLoading && !error && jobs.length > 0 && (
        <div className="mt-4 grid gap-4 lg:grid-cols-[260px_1fr]">
          {/* 左：项目+任务树导航 */}
          <div className="lg:sticky lg:top-20 lg:h-fit">
            <TaskTree jobs={jobs} activeJobId={activeJobId} onSelect={setActiveJobId} />
          </div>
          {/* 右：状态看板（只放可执行子任务） */}
          <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
            {COLUMNS.map((col) => {
              const colJobs = board.get(col.state) ?? [];
              return (
                <div
                  key={col.state}
                  className={`flex min-h-[120px] flex-col gap-2 rounded-xl border p-2 ${COLUMN_BG[col.state] ?? "bg-muted/30"}`}
                >
                  <div className={`flex items-center justify-between border-b-2 px-1.5 pb-1.5 ${COLUMN_HEADER_COLORS[col.state] ?? "border-slate-300"}`}>
                    <span className="flex items-center gap-1.5 text-sm font-bold">
                      <StateIcon state={col.state} />
                      {col.label}
                    </span>
                    <span className="rounded-full bg-background px-2 py-0.5 text-xs font-bold text-foreground shadow-sm">
                      {colJobs.length}
                    </span>
                  </div>
                  <div className="flex flex-1 flex-col gap-2">
                    {colJobs.length === 0 && (
                      <div className="flex flex-1 items-center justify-center rounded-lg border border-dashed px-3 py-6 text-center text-xs text-muted-foreground/60">
                        {L("None")}
                      </div>
                    )}
                    {colJobs.map((j) => (
                      <JobNode
                        key={j.id}
                        job={j}
                        currentUserId={currentUserId}
                        isAdmin={isAdmin}
                        rootTitle={rootTitleById.get(j.id)}
                        highlighted={activeJobId === j.id}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
