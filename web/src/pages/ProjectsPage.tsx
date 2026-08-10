/**
 * 项目明细页：项目信息、团队成员、任务流程（YAML）、会话记录。
 *
 * 项目 = 顶级分组（名称 + 团队池）；项目下的任务各自配置工作流
 * （YAML steps）与工作团队。任务执行过程在 /jobs 页关注。
 */
import { lazy, useCallback, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BriefcaseIcon,
  FolderIcon,
  MessageSquareIcon,
  PlusIcon,
  RefreshCwIcon,
  SettingsIcon,
  UsersIcon,
  XIcon,
} from "lucide-react";
import { authenticatedFetch } from "@/lib/identity";
import { useSearchParams } from "@/lib/routing";
import { L } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

interface ProjectWire {
  id: string;
  name: string;
  kind: string;
  owner_user_id?: string | null;
  config?: Record<string, unknown>;
  members?: { user_id: string; role: number }[];
}

const SubagentsPanel = lazy(() =>
  import("@/shell/SubagentsPanel").then((m) => ({ default: m.SubagentsPanel })),
);

interface JobWire {
  id: string;
  title: string;
  state: string;
  parent_job_id?: string | null;
  config?: string | null;
  assignee_user_id?: string | null;
  agent_name?: string | null;
  depends_on?: string | null;
  session_id?: string | null;
  children?: JobWire[];
}

const STATE_LABELS: Record<string, string> = {
  todo: "待办",
  in_progress: "进行中",
  in_review: "待验收",
  completed: "已完成",
  returned: "返工",
};

/** 项目信息 + 团队池 tab */
function ProjectInfoCard({
  project,
  onRefresh,
}: {
  project: ProjectWire;
  onRefresh: () => void;
}) {
  const [addingMember, setAddingMember] = useState("");
  const queryClient = useQueryClient();
  const addMember = useCallback(async () => {
    const uid = addingMember.trim();
    if (!uid) return;
    await authenticatedFetch(`/v1/projects/${project.id}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: uid }),
    });
    setAddingMember("");
    await queryClient.invalidateQueries({ queryKey: ["projects"] });
    onRefresh();
  }, [project.id, addingMember, onRefresh, queryClient]);

  const removeMember = useCallback(
    async (uid: string) => {
      await authenticatedFetch(`/v1/projects/${project.id}/members/${uid}`, {
        method: "DELETE",
      });
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
      onRefresh();
    },
    [project.id, onRefresh, queryClient],
  );

  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-center gap-2">
        <FolderIcon className="size-4 text-blue-600" />
        <span className="text-sm font-semibold">{project.name}</span>
        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px]">{project.kind}</span>
        {project.owner_user_id && (
          <span className="text-[11px] text-muted-foreground">
            项目经理: {project.owner_user_id}
          </span>
        )}
      </div>
      <div className="space-y-1.5">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          <UsersIcon className="size-3.5" /> {L("Work team")}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {(project.members ?? []).map((m) => (
            <span key={m.user_id} className="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs">
              {m.user_id}
              <button
                type="button"
                className="text-muted-foreground hover:text-destructive"
                onClick={() => removeMember(m.user_id)}
                title="移除"
              >
                <XIcon className="size-3" />
              </button>
            </span>
          ))}
        </div>
        <div className="flex items-center gap-1.5">
          <Input
            value={addingMember}
            onChange={(e) => setAddingMember(e.target.value)}
            placeholder="添加成员 user_id"
            className="h-7 w-48 text-xs"
          />
          <Button type="button" size="sm" className="h-7 px-2 text-xs" onClick={addMember}>
            <PlusIcon className="size-3" /> {L("Add")}
          </Button>
        </div>
      </div>
    </Card>
  );
}

/** 任务 YAML 工作流编辑（直接编辑 YAML 文本） */
function TaskWorkflowEditor({
  job,
  onSaved,
}: {
  job: JobWire;
  onSaved: () => void;
}) {
  const [yaml, setYaml] = useState(() => {
    if (job.config) {
      try {
        const cfg = JSON.parse(job.config);
        const wf = cfg.workflow ?? {};
        const steps = wf.steps ?? [];
        return (
          "workflow:\n  steps:\n" +
          steps
            .map((st: Record<string, unknown>) => {
              const lines = [`    - id: ${st.id}`, `      name: ${st.name}`];
              if (st.agent) lines.push(`      agent: ${st.agent}`);
              if (st.depends_on) {
                const deps = Array.isArray(st.depends_on)
                  ? st.depends_on.map((d) => `"${d}"`).join(", ")
                  : `"${st.depends_on}"`;
                lines.push(`      depends_on: [${deps}]`);
              }
              return lines.join("\n");
            })
            .join("\n")
        );
      } catch {
        return job.config;
      }
    }
    return "workflow:\n  steps:\n    - id: requirement\n      name: 需求分析\n      auto_approve: true\n    - id: develop\n      name: 开发\n      agent: pi-native-ui\n      depends_on: requirement\n    - id: testing\n      name: 测试\n      agent: pi-native-ui\n      depends_on: develop";
  });
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      // 简单 YAML 解析（steps 的 id/name/agent/depends_on/auto_* 缩进块）
      type StepRec = {
        id: string;
        name: string;
        agent?: string;
        depends_on?: string[];
        auto_accept?: boolean;
        auto_approve?: boolean;
      };
      const steps: StepRec[] = [];
      let current: StepRec | null = null;
      for (const line of yaml.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        if (/^- id:/.test(trimmed)) {
          if (current) steps.push(current);
          current = { id: trimmed.replace(/^- id:\s*/, "").trim(), name: "" };
        } else if (current) {
          const m = trimmed.match(/^(\w+):\s*(.*)$/);
          if (m) {
            const [, key, val] = m;
            const v = val.trim();
            if (key === "name") current.name = v;
            else if (key === "agent") current.agent = v;
            else if (key === "depends_on") {
              const deps = v
                .replace(/[\[\]"]/g, "")
                .split(",")
                .map((d) => d.trim())
                .filter(Boolean);
              if (deps.length) current.depends_on = deps;
            } else if (key === "auto_accept") current.auto_accept = /^true$/i.test(v);
            else if (key === "auto_approve") current.auto_approve = /^true$/i.test(v);
          }
        }
      }
      if (current) steps.push(current);
      if (!steps.length) throw new Error("至少需要一个 step");
      const config = JSON.stringify({ workflow: { steps } });
      const res = await authenticatedFetch(`/v1/jobs/${job.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config }),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      await queryClient.invalidateQueries({ queryKey: ["jobs"] });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [yaml, job.id, onSaved, queryClient]);

  return (
    <div className="space-y-1.5">
      <textarea
        value={yaml}
        onChange={(e) => setYaml(e.target.value)}
        spellCheck={false}
        className="h-52 w-full resize-y rounded-md border bg-muted/30 p-2 font-mono text-[11px] leading-relaxed"
      />
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex justify-end">
        <Button type="button" size="sm" className="h-7 px-2 text-xs" onClick={save} disabled={saving}>
          {saving ? L("Saving…") : L("Save workflow")}
        </Button>
      </div>
    </div>
  );
}

/** 添加任务：YAML 工作流直接创建主任务（自动生成子任务树） */
function AddTaskForm({
  projectId,
  onDone,
}: {
  projectId: string;
  onDone: () => void;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [yaml, setYaml] = useState(
    "workflow:\n  steps:\n    - id: requirement\n      name: 需求分析\n      agent: zhangsan-agent\n    - id: architecture\n      name: 架构设计\n      agent: wangwu-agent\n      depends_on: [requirement]\n    - id: test\n      name: 测试验证\n      agent: admin-agent\n      depends_on: [architecture]",
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      // 简单 YAML 解析 steps（id/name/agent/depends_on）
      type StepRec = {
        id: string;
        name: string;
        agent?: string;
        depends_on?: string[];
        auto_accept?: boolean;
        auto_approve?: boolean;
      };
      const steps: StepRec[] = [];
      let cur: StepRec | null = null;
      for (const line of yaml.split("\n")) {
        const t = line.trim();
        if (!t || t.startsWith("#")) continue;
        if (/^- id:/.test(t)) {
          if (cur) steps.push(cur);
          cur = { id: t.replace(/^- id:\s*/, "").trim(), name: "" };
        } else if (cur) {
          const m = t.match(/^(\w+):\s*(.*)$/);
          if (m) {
            const [, key, val] = m;
            const v = val.trim();
            if (key === "name") cur.name = v;
            else if (key === "agent") cur.agent = v;
            else if (key === "depends_on") {
              const deps = v
                .replace(/[\[\]"]/g, "")
                .split(",")
                .map((d) => d.trim())
                .filter(Boolean);
              if (deps.length) cur.depends_on = deps;
            } else if (key === "auto_accept") cur.auto_accept = /^true$/i.test(v);
            else if (key === "auto_approve") cur.auto_approve = /^true$/i.test(v);
          }
        }
      }
      if (cur) steps.push(cur);
      if (!steps.length) throw new Error("至少需要一个 step");
      const payload: Record<string, unknown> = { title: title.trim() };
      if (description.trim()) payload.description = description.trim();
      payload.project_id = projectId;
      payload.config = { workflow: { steps } };
      const res = await authenticatedFetch("/v1/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      await queryClient.invalidateQueries({ queryKey: ["jobs"] });
      await queryClient.invalidateQueries({ queryKey: ["project-jobs"] });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [title, description, yaml, projectId, onDone, queryClient]);

  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">{L("Add task")}</span>
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>
          <XIcon className="size-3.5" />
        </Button>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="space-y-1">
          <span className="text-sm">{L("Task title")}</span>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="电商平台开发" className="h-8 text-sm" />
        </label>
        <label className="space-y-1">
          <span className="text-sm">{L("Description")}</span>
          <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="任务描述" className="h-8 text-sm" />
        </label>
      </div>
      <div className="space-y-1">
        <span className="text-sm">{L("Workflow YAML")}</span>
        <textarea
          value={yaml}
          onChange={(e) => setYaml(e.target.value)}
          spellCheck={false}
          className="h-48 w-full resize-y rounded-md border bg-muted/30 p-2 font-mono text-[11px] leading-relaxed"
        />
        <p className="text-[11px] text-muted-foreground">
          steps: id(唯一) + name(显示) + agent(绑定成员) + depends_on(step id 列表)；保存后自动生成任务树
        </p>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex justify-end">
        <Button type="button" size="sm" disabled={saving || !title.trim()} onClick={save}>
          {saving ? L("Saving…") : L("Create task")}
        </Button>
      </div>
    </Card>
  );
}

/** 流程列表：项目下所有任务 + YAML + 状态 */
function FlowList({
  projectId,
  onRefresh,
}: {
  projectId: string;
  onRefresh: () => void;
}) {
  const { data: jobs = [], refetch } = useQuery({
    queryKey: ["project-jobs", projectId],
    queryFn: async () => {
      const res = await authenticatedFetch(`/v1/jobs?scope=project&project_id=${projectId}`);
      if (!res.ok) throw new Error(`${res.status}`);
      return (await res.json()).jobs as JobWire[];
    },
    staleTime: 10_000,
  });
  const [editingJob, setEditingJob] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">{L("Flow list")}</span>
        <div className="flex items-center gap-1.5">
          <Button type="button" size="sm" className="h-7 px-2 text-xs" onClick={() => setShowAdd((v) => !v)}>
            <PlusIcon className="size-3" /> {L("Add task")}
          </Button>
          <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={refetch}>
            <RefreshCwIcon className="size-3" /> {L("Refresh")}
          </Button>
        </div>
      </div>
      {showAdd && (
        <AddTaskForm
          projectId={projectId}
          onDone={() => {
            setShowAdd(false);
            refetch();
          }}
        />
      )}
      {(() => {
        // Flatten the task tree (main task + children), no "阶段" concept.
        const rows: { job: JobWire; depth: number }[] = [];
        const walk = (list: JobWire[], depth: number) => {
          for (const j of list) {
            rows.push({ job: j, depth });
            if (j.children?.length) walk(j.children, depth + 1);
          }
        };
        walk(jobs, 0);
        return rows.map(({ job: j, depth }) => (
          <Card key={j.id} className="p-3" style={{ marginLeft: depth > 0 ? `${depth * 16}px` : 0 }}>
            <div className="flex items-center gap-2">
              {depth > 0 && <span className="text-muted-foreground">└</span>}
              <span className="text-sm font-semibold">{j.title}</span>
              <span className={`rounded px-1.5 py-0.5 text-[10px] ${depth === 0 ? "bg-blue-100 text-blue-700" : "bg-muted"}`}>
                {depth === 0 ? "主任务" : "任务"}
              </span>
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px]">{STATE_LABELS[j.state] ?? j.state}</span>
              {j.assignee_user_id && <span className="text-[11px] text-muted-foreground">→ {j.assignee_user_id}</span>}
              {depth === 0 && (
                <Button type="button" variant="ghost" size="sm" className="ml-auto h-6 px-2 text-xs" onClick={() => setEditingJob(editingJob === j.id ? null : j.id)}>
                  {editingJob === j.id ? "关闭" : "编辑 YAML"}
                </Button>
              )}
            </div>
            {depth === 0 && editingJob === j.id && (
              <div className="mt-2 border-t pt-2">
                <TaskWorkflowEditor job={j} onSaved={() => { setEditingJob(null); refetch(); }} />
              </div>
            )}
          </Card>
        ));
      })()}
    </div>
  );
}

/** 执行关系图：项目主任务的会话为根，子会话（各成员执行）为协作树 */
function CollaborationGraph({ projectId }: { projectId: string }) {
  const { data: jobs = [] } = useQuery({
    queryKey: ["graph-jobs", projectId],
    queryFn: async () => {
      const res = await authenticatedFetch(`/v1/jobs?scope=project&project_id=${projectId}`);
      if (!res.ok) throw new Error(`${res.status}`);
      return (await res.json()).jobs ?? [];
    },
    staleTime: 10_000,
  });
  const mainRoot = jobs.find((j) => !j.parent_job_id);
  if (!mainRoot?.session_id) {
    return <p className="text-xs text-muted-foreground">暂无执行会话（任务启动后显示协作树）</p>;
  }
  return (
    <div className="rounded-lg border p-2">
      <SubagentsPanel conversationId={mainRoot.session_id} rootSessionId={mainRoot.session_id} />
    </div>
  );
}

/** 会话记录：执行关系图 + 项目下所有会话 */
function SessionList({ projectId }: { projectId: string }) {
  const { data: sessions = [] } = useQuery({
    queryKey: ["project-sessions-list", projectId],
    queryFn: async () => {
      const res = await authenticatedFetch(`/v1/projects/${projectId}/sessions`);
      if (!res.ok) throw new Error(`${res.status}`);
      return (await res.json()).data ?? [];
    },
    staleTime: 10_000,
  });
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <span className="text-sm font-medium">{L("Execution graph")}</span>
        <CollaborationGraph projectId={projectId} />
      </div>
      <div className="space-y-1.5 border-t pt-2">
        <span className="text-sm font-medium">{L("Session records")}</span>
        {sessions.length === 0 && <p className="text-xs text-muted-foreground">暂无会话</p>}
        {sessions.map((s) => (
          <a key={s.id} href={`/c/${s.id}`} className="flex items-center gap-2 rounded-md border px-2 py-1.5 text-xs hover:bg-muted">
            <MessageSquareIcon className="size-3" />
            {s.title}
          </a>
        ))}
      </div>
    </div>
  );
}

/** 项目明细页 */
/** 项目设置（官方功能）：默认工作目录/主机 + 项目记忆 + 项目上下文 */
function ProjectSettingsCard({
  project,
  onSaved,
}: {
  project: ProjectWire;
  onSaved: () => void;
}) {
  const config = project.config ?? {};
  const defaults = (config.defaults ?? {}) as Record<string, string>;
  const [workspace, setWorkspace] = useState(defaults.workspace ?? "");
  const [hostId, setHostId] = useState(defaults.host_id ?? "");
  const [memory, setMemory] = useState((config.memory as string) ?? "");
  const [context, setContext] = useState((config.context as string) ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const { data: hosts = [] } = useQuery({
    queryKey: ["hosts-options"],
    queryFn: async () => {
      const res = await authenticatedFetch("/v1/hosts");
      if (!res.ok) return [];
      return ((await res.json()) as { hosts: { host_id: string; owner?: string }[] }).hosts ?? [];
    },
    staleTime: 30_000,
  });

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const configPayload: Record<string, unknown> = {};
      if (workspace.trim() || hostId.trim()) {
        configPayload.defaults = {
          ...(workspace.trim() ? { workspace: workspace.trim() } : {}),
          ...(hostId.trim() ? { host_id: hostId.trim() } : {}),
        };
      }
      if (memory.trim()) configPayload.memory = memory.trim();
      if (context.trim()) configPayload.context = context.trim();
      const res = await authenticatedFetch(`/v1/projects/${project.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: configPayload }),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [workspace, hostId, memory, context, project.id, onSaved, queryClient]);

  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-center gap-2">
        <SettingsIcon className="size-4" />
        <span className="text-sm font-semibold">{L("Project settings")}</span>
        <span className="text-[11px] text-muted-foreground">（官方功能：默认工作目录/主机/记忆/上下文）</span>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1">
          <span className="text-sm">{L("Default working directory")}</span>
          <Input value={workspace} onChange={(e) => setWorkspace(e.target.value)} placeholder="/workspace/电商平台" className="h-8 text-sm" />
          <p className="text-[11px] text-muted-foreground">新会话/任务预填此目录（软提示，可覆盖）</p>
        </label>
        <label className="space-y-1">
          <span className="text-sm">{L("Default host")}</span>
          <select value={hostId} onChange={(e) => setHostId(e.target.value)} className="h-8 w-full rounded-md border bg-background px-2 text-sm">
            <option value="">不指定（由执行者选）</option>
            {hosts.map((h) => (
              <option key={h.host_id} value={h.host_id}>
                {h.owner ?? h.host_id.slice(0, 8)}
              </option>
            ))}
          </select>
          <p className="text-[11px] text-muted-foreground">新会话预填此主机（host 离线则丢弃）</p>
        </label>
      </div>
      <label className="space-y-1">
        <span className="text-sm">{L("Project memory")}</span>
        <textarea value={memory} onChange={(e) => setMemory(e.target.value)} spellCheck={false}
          placeholder={"项目级记忆（跨会话累积的经验，播种到每个任务会话）"}
          className="h-24 w-full resize-y rounded-md border bg-muted/30 p-2 text-xs" />
      </label>
      <label className="space-y-1">
        <span className="text-sm">{L("Project context")}</span>
        <textarea value={context} onChange={(e) => setContext(e.target.value)} spellCheck={false}
          placeholder={"项目级指令/文档（每个任务会话注入）"}
          className="h-24 w-full resize-y rounded-md border bg-muted/30 p-2 text-xs" />
      </label>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex justify-end">
        <Button type="button" size="sm" className="h-7 px-3 text-xs" onClick={save} disabled={saving}>
          {saving ? L("Saving…") : L("Save settings")}
        </Button>
      </div>
    </Card>
  );
}

/** 新建项目：名称 + 成员（host 池）+ 项目级 YAML（备用） */
function CreateProjectForm({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState("");
  const [members, setMembers] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const { data: memberOptions = [] } = useQuery({
    queryKey: ["member-options"],
    queryFn: async () => {
      const res = await authenticatedFetch("/v1/hosts");
      if (!res.ok) return [];
      const hosts = ((await res.json()) as { hosts: { owner?: string }[] }).hosts ?? [];
      return [...new Set(hosts.map((h) => h.owner).filter(Boolean))] as string[];
    },
    staleTime: 30_000,
  });

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await authenticatedFetch("/v1/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), kind: "team" }),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      const project = (await res.json()) as ProjectWire;
      for (const m of members) {
        await authenticatedFetch(`/v1/projects/${project.id}/members`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ user_id: m, role: 1 }),
        });
      }
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [name, members, onDone, queryClient]);

  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">{L("New project")}</span>
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>
          <XIcon className="size-3.5" />
        </Button>
      </div>
      <label className="space-y-1">
        <span className="text-sm">{L("Project name")}</span>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="电商平台" className="h-8 text-sm" />
      </label>
      <label className="space-y-1">
        <span className="text-sm">{L("Work team")}</span>
        <div className="flex flex-wrap gap-2">
          {memberOptions.map((m) => (
            <label key={m} className="flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs">
              <input
                type="checkbox"
                className="size-3.5 accent-primary"
                checked={members.includes(m)}
                onChange={(e) =>
                  setMembers((prev) => (e.target.checked ? [...prev, m] : prev.filter((x) => x !== m)))
                }
              />
              {m}
            </label>
          ))}
        </div>
      </label>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex justify-end">
        <Button type="button" size="sm" disabled={saving || !name.trim()} onClick={save}>
          {saving ? L("Saving…") : L("Create")}
        </Button>
      </div>
    </Card>
  );
}

export function ProjectsPage() {
  const [projectId, setProjectId] = useState<string>("");
  const [showCreateProject, setShowCreateProject] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const queryClient = useQueryClient();
  const { data: projects = [] } = useQuery({
    queryKey: ["projects", refreshKey],
    queryFn: async () => {
      const res = await authenticatedFetch("/v1/projects");
      if (!res.ok) throw new Error(`${res.status}`);
      return ((await res.json()) as { data: ProjectWire[] }).data ?? [];
    },
    staleTime: 10_000,
  });
  const teamProjects = projects.filter((p) => p.kind === "team");
  const [searchParams] = useSearchParams();
  const urlProject = searchParams.get("project");
  const active =
    teamProjects.find((p) => p.id === projectId) ??
    (urlProject ? teamProjects.find((p) => p.name === urlProject) : null) ??
    teamProjects[0] ??
    null;
  const refresh = useCallback(() => {
    setRefreshKey((k) => k + 1);
    queryClient.invalidateQueries({ queryKey: ["project-jobs"] });
    queryClient.invalidateQueries({ queryKey: ["project-sessions-list"] });
  }, [queryClient]);

  const tabs = useMemo(() => {
    const list: { id: string; label: string }[] = [
      { id: "settings", label: "项目设置" },
      { id: "info", label: "项目成员" },
      { id: "flows", label: "流程列表" },
      { id: "sessions", label: "会话记录" },
    ];
    return list;
  }, []);
  const [tab, setTab] = useState("info");

  return (
    <section className="h-full overflow-y-auto px-4 pb-4 pt-16">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <BriefcaseIcon className="size-6" /> {L("Projects")}
        </h1>
        <div className="flex items-center gap-2">
          <Button type="button" size="sm" onClick={() => setShowCreateProject((v) => !v)}>
            <PlusIcon className="size-3.5" /> {L("New project")}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={refresh}>
            <RefreshCwIcon className="size-3.5" /> {L("Refresh")}
          </Button>
        </div>
      </div>
      {showCreateProject && (
        <div className="mt-3">
          <CreateProjectForm onDone={() => { setShowCreateProject(false); refresh(); }} />
        </div>
      )}

      {teamProjects.length > 0 && (
        <div className="mt-3 overflow-x-auto">
          <div className="flex min-w-max gap-1.5">
            {teamProjects.map((p) => (
              <Button
                key={p.id}
                type="button"
                size="sm"
                variant={active?.id === p.id ? "default" : "outline"}
                className="h-7 whitespace-nowrap text-xs"
                onClick={() => setProjectId(p.id)}
              >
                <FolderIcon className="size-3 shrink-0" /> {p.name}
              </Button>
            ))}
          </div>
        </div>
      )}

      {active ? (
        <div className="mt-3">
          <div className="flex gap-1 border-b">
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={`px-3 py-1.5 text-sm ${tab === t.id ? "border-b-2 border-blue-600 font-semibold" : "text-muted-foreground"}`}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="mt-3">
            {tab === "settings" && <ProjectSettingsCard project={active} onSaved={refresh} />}
            {tab === "info" && <ProjectInfoCard project={active} onRefresh={refresh} />}
            {tab === "flows" && <FlowList projectId={active.id} onRefresh={refresh} />}
            {tab === "sessions" && <SessionList projectId={active.id} />}
          </div>
        </div>
      ) : (
        <p className="mt-6 text-sm text-muted-foreground">
          暂无项目 — 在任务页「新建团队项目」创建。
        </p>
      )}
    </section>
  );
}
