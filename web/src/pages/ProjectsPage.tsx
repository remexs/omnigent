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
  UsersIcon,
  XIcon,
} from "lucide-react";
import { authenticatedFetch } from "@/lib/identity";
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
    return "workflow:\n  steps:\n    - id: requirement\n      name: 需求分析\n      agent: zhangsan-agent";
  });
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      // 简单 YAML 解析（steps 的 id/name/agent/depends_on 缩进块）
      const steps: { id: string; name: string; agent?: string; depends_on?: string[] }[] = [];
      let current: { id: string; name: string; agent?: string; depends_on?: string[] } | null = null;
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
            if (key === "name") current.name = val.trim();
            else if (key === "agent") current.agent = val.trim();
            else if (key === "depends_on") {
              const deps = val
                .replace(/[\[\]"]/g, "")
                .split(",")
                .map((d) => d.trim())
                .filter(Boolean);
              if (deps.length) current.depends_on = deps;
            }
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

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">{L("Flow list")}</span>
        <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={refetch}>
          <RefreshCwIcon className="size-3" /> {L("Refresh")}
        </Button>
      </div>
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
  const SubagentsPanel = lazy(() =>
    import("@/shell/SubagentsPanel").then((m) => ({ default: m.SubagentsPanel })),
  );
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
export function ProjectsPage() {
  const [projectId, setProjectId] = useState<string>("");
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
  const active = teamProjects.find((p) => p.id === projectId) ?? teamProjects[0] ?? null;
  const refresh = useCallback(() => {
    setRefreshKey((k) => k + 1);
    queryClient.invalidateQueries({ queryKey: ["project-jobs"] });
    queryClient.invalidateQueries({ queryKey: ["project-sessions-list"] });
  }, [queryClient]);

  const tabs = useMemo(() => {
    const list: { id: string; label: string }[] = [
      { id: "info", label: "项目明细" },
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
        <Button type="button" variant="outline" size="sm" onClick={refresh}>
          <RefreshCwIcon className="size-3.5" /> {L("Refresh")}
        </Button>
      </div>

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
