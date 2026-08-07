import { useCallback, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BriefcaseIcon,
  CheckCircle2Icon,
  CircleIcon,
  CircleDotIcon,
  GitBranchIcon,
  PlusIcon,
  RefreshCwIcon,
  ServerIcon,
  ShieldIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
  XIcon,
} from "lucide-react";
import { authenticatedFetch } from "@/lib/identity";
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
  pending_review: "待评价",
  completed: "已完成",
  returned: "打回",
  blocked: "阻塞",
};

const STATE_COLORS: Record<string, string> = {
  todo: "bg-slate-100 text-slate-700",
  in_progress: "bg-blue-100 text-blue-700",
  pending_review: "bg-amber-100 text-amber-700",
  completed: "bg-green-100 text-green-700",
  returned: "bg-red-100 text-red-700",
  blocked: "bg-slate-100 text-slate-500",
};

/** 列头状态色（色条 + 文字） */
const COLUMN_HEADER_COLORS: Record<string, string> = {
  todo: "text-slate-700 border-slate-300",
  in_progress: "text-blue-700 border-blue-400",
  pending_review: "text-amber-700 border-amber-400",
  completed: "text-green-700 border-green-500",
  returned: "text-red-700 border-red-400",
  blocked: "text-slate-500 border-slate-300",
};

const COLUMN_BG: Record<string, string> = {
  todo: "bg-slate-50/60",
  in_progress: "bg-blue-50/40",
  pending_review: "bg-amber-50/40",
  completed: "bg-green-50/40",
  returned: "bg-red-50/40",
  blocked: "bg-slate-50/40",
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
  if (state === "pending_review") return <ThumbsUpIcon className="size-4 text-amber-500" />;
  if (state === "returned") return <ThumbsDownIcon className="size-4 text-red-500" />;
  return <CircleIcon className="size-4 text-muted-foreground" />;
}

/** Create-team-project dialog: name + members + flow phases. */
function CreateProjectForm({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState("");
  // Members picked from the user/host list (participant pool).
  const [selectedMembers, setSelectedMembers] = useState<string[]>([]);
  // Workflow phases: name + agent (agent binds member+host) + mode.
  const [phases, setPhases] = useState([
    { name: "需求分析", agent: "zhangsan-agent", mode: "manual" },
    { name: "架构设计", agent: "wangwu-agent", mode: "manual" },
    { name: "后端开发", agent: "zhaoliu-agent", mode: "manual" },
    { name: "前端开发", agent: "lisi-agent", mode: "manual" },
    { name: "测试验证", agent: "admin-agent", mode: "manual" },
  ]);
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
      // Each phase: agent auto-resolves assignee via owner (member+host).
      const cleanPhases = phases
        .map((p) => ({ ...p, name: p.name.trim() }))
        .filter((p) => p.name);
      const res = await authenticatedFetch("/v1/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          kind: "team",
          config: { workflow: { phases: cleanPhases } },
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
  }, [name, selectedMembers, phases, onDone, queryClient]);

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

      {/* 执行流程（工作流 YAML 定义：阶段 + agent 下拉，agent 绑定成员/主机） */}
      <div className="space-y-1">
        <span className="text-sm">{L("Flow phases")}（agent 自动绑定成员与主机）</span>
        <div className="space-y-1.5">
          {phases.map((ph, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <Input
                className="flex-1"
                placeholder={L("Phase name")}
                value={ph.name}
                onChange={(e) =>
                  setPhases((prev) => prev.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))
                }
              />
              <Select
                value={ph.agent}
                onValueChange={(v) =>
                  setPhases((prev) => prev.map((x, j) => (j === i ? { ...x, agent: v } : x)))
                }
              >
                <SelectTrigger className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {agentOptions.map((a) => (
                    <SelectItem key={a.name} value={a.name}>
                      {a.name}{a.owner_user_id ? ` (@${a.owner_user_id})` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={ph.mode}
                onValueChange={(v) =>
                  setPhases((prev) => prev.map((x, j) => (j === i ? { ...x, mode: v } : x)))
                }
              >
                <SelectTrigger className="w-24">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="manual">manual</SelectItem>
                  <SelectItem value="auto">auto</SelectItem>
                </SelectContent>
              </Select>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 w-8 shrink-0 px-0"
                onClick={() => setPhases((prev) => prev.filter((_, j) => j !== i))}
                aria-label="remove phase"
              >
                <XIcon className="size-3.5" />
              </Button>
            </div>
          ))}
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-1"
          onClick={() => setPhases((prev) => [...prev, { name: "", agent: "zhangsan-agent", mode: "manual" }])}
        >
          <PlusIcon className="size-3.5" /> {L("Add phase")}
        </Button>
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
function CreateJobForm({ onDone }: { onDone: () => void }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [agentName, setAgentName] = useState("");
  const [assignee, setAssignee] = useState("");
  const [parentId, setParentId] = useState("");
  const [requireApproval, setRequireApproval] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

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
      const res = await authenticatedFetch("/v1/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      await queryClient.invalidateQueries({ queryKey: ["jobs"] });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [title, description, agentName, assignee, parentId, requireApproval, onDone, queryClient]);

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

/** One job card in the board. */
function JobNode({ job, depth = 0 }: { job: JobWire; depth?: number }) {
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

  const hasDetail = (job.artifacts?.length ?? 0) > 0 || (job.evaluations?.length ?? 0) > 0 || (job.children?.length ?? 0) > 0;

  // Root (main task) progress: fraction of completed children.
  const children = job.children ?? [];
  const isMainTask = !job.parent_job_id && children.length > 0;
  const doneCount = children.filter((c) => c.state === "completed").length;
  const progress = children.length > 0 ? Math.round((doneCount / children.length) * 100) : 0;

  return (
    <div>
      <Card
        className={`group relative overflow-hidden p-3 transition-shadow hover:shadow-md ${
          depth > 0 ? "ml-3 border-dashed" : ""
        }`}
      >
        {/* 顶部状态色条 */}
        <div className={`absolute inset-x-0 top-0 h-0.5 ${STATE_COLORS[job.state].split(" ")[0]}`} />

        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-start gap-2">
            <StateIcon state={job.state} />
            <div className="min-w-0">
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
                {job.require_approval && job.state === "blocked" && (
                  <span className="inline-flex items-center gap-1 text-amber-600">
                    <ShieldIcon className="size-3" />
                    {L("Awaiting approval")}
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
            {job.state === "todo" && (
              <Button type="button" variant="outline" size="sm" className="h-6 px-2 text-xs" onClick={claim}>
                {L("Claim")}
              </Button>
            )}
            {job.state === "in_progress" && !job.session_id && (
              <Button type="button" variant="outline" size="sm" className="h-6 px-2 text-xs" onClick={() => setShowLaunch(true)}>
                <GitBranchIcon className="size-3" /> {L("Launch")}
              </Button>
            )}
            {job.state === "in_progress" && job.session_id && (
              <Button type="button" variant="outline" size="sm" className="h-6 px-2 text-xs text-green-600" onClick={submit}>
                <CheckCircle2Icon className="size-3" /> {L("Submit")}
              </Button>
            )}
            {job.state === "pending_review" && (
              <Button type="button" variant="outline" size="sm" className="h-6 px-2 text-xs" onClick={() => setShowEvaluate(true)}>
                <ThumbsUpIcon className="size-3" /> {L("Evaluate")}
              </Button>
            )}
            {job.state === "blocked" && job.require_approval && (
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

        {/* 主任务进度条 */}
        {isMainTask && (
          <div className="mt-2">
            <div className="mb-1 flex items-center justify-between text-[11px] text-muted-foreground">
              <span>{L("Progress")}</span>
              <span className="font-semibold text-foreground">{progress}%</span>
            </div>
            <div className="flex h-1.5 gap-0.5 overflow-hidden rounded-full">
              {children.map((c) => (
                <div
                  key={c.id}
                  className={`flex-1 rounded-full ${
                    c.state === "completed"
                      ? "bg-green-500"
                      : c.state === "in_progress" || c.state === "pending_review"
                        ? "bg-amber-400"
                        : "bg-muted"
                  }`}
                  title={c.title}
                />
              ))}
            </div>
            <div className="mt-1 text-[11px] text-muted-foreground">
              {doneCount}/{children.length} {L("tasks done")}
            </div>
          </div>
        )}

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

        {/* 子任务 */}
        {job.children && job.children.length > 0 && (
          <div className="mt-2 space-y-1.5">
            {job.children.map((c) => (
              <JobNode key={c.id} job={c} depth={depth + 1} />
            ))}
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
    { state: "pending_review", label: STATE_LABELS.pending_review },
    { state: "completed", label: STATE_LABELS.completed },
    { state: "returned", label: STATE_LABELS.returned },
    { state: "blocked", label: STATE_LABELS.blocked },
  ];

  const board = useMemo(() => {
    const byCol = new Map<string, JobWire[]>();
    for (const col of COLUMNS) byCol.set(col.state, []);
    for (const j of jobs) {
      const col = byCol.get(j.state);
      if (col) col.push(j);
    }
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
          <Button type="button" size="sm" onClick={() => setShowCreate((v) => !v)}>
            <PlusIcon className="size-3.5" /> {L("New job")}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => setShowCreateProject((v) => !v)}>
            <BriefcaseIcon className="size-3.5" /> {L("New team project")}
          </Button>
        </div>
      </div>
      {showCreateProject && (
        <div className="mt-4">
          <CreateProjectForm onDone={() => setShowCreateProject(false)} />
        </div>
      )}

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

      {showCreate && (
        <div className="mt-4" id="new-job-form" ref={(el) => { if (el) el.scrollIntoView({ behavior: "smooth", block: "nearest" }); }}>
          <CreateJobForm onDone={() => setShowCreate(false)} />
        </div>
      )}

      {isLoading && <p className="mt-4 text-sm text-muted-foreground">{L("Loading…")}</p>}
      {error && (
        <p className="mt-4 text-sm text-destructive">
          {L("Failed to load:")} {String(error)}
        </p>
      )}
      {!isLoading && !error && jobs.length === 0 && (
        <p className="mt-4 text-sm text-muted-foreground">{L("No jobs yet. Create one to start.")}</p>
      )}

      {/* 多列看板 */}
      {!isLoading && !error && jobs.length > 0 && (
        <div className="mt-4 grid gap-3 md:grid-cols-3 xl:grid-cols-6">
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
                    <JobNode key={j.id} job={j} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
