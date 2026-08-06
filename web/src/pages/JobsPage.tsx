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
  created_at?: number;
  artifacts?: { id: string; artifact_type: string; ref?: string | null; summary?: string | null }[];
  evaluations?: { id: string; action: string; evaluator_user_id?: string | null; comment?: string | null }[];
  children?: JobWire[];
}

interface JobStatsWire {
  total_jobs?: number;
  by_state?: Record<string, number>;
  total_rounds?: number;
  total_rejects?: number;
  root_count?: number;
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

/** Create-job dialog. */
function CreateJobForm({ onDone }: { onDone: () => void }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [agentName, setAgentName] = useState("");
  const [assignee, setAssignee] = useState("");
  const [parentId, setParentId] = useState("");
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
  }, [title, description, agentName, assignee, parentId, onDone, queryClient]);

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

/** One job node in the tree. */
function JobNode({ job, depth = 0 }: { job: JobWire; depth?: number }) {
  const [showEvaluate, setShowEvaluate] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const queryClient = useQueryClient();
  const indent = { paddingLeft: `${depth * 20 + 8}px` };

  const claim = useCallback(async () => {
    await authenticatedFetch(`/v1/jobs/${job.id}/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    await queryClient.invalidateQueries({ queryKey: ["jobs"] });
  }, [job.id, queryClient]);

  const launch = useCallback(async () => {
    const res = await authenticatedFetch(`/v1/jobs/${job.id}/launch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        host_id: "30ccdc66801f4b359963974a6e37493c",
        workspace: "/tmp/team_test2",
      }),
    });
    if (!res.ok) alert(`Launch failed: ${res.status}`);
    await queryClient.invalidateQueries({ queryKey: ["jobs"] });
  }, [job.id, queryClient]);

  return (
    <div>
      <div
        className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-accent/40"
        style={indent}
      >
        <StateIcon state={job.state} />
        <span className="font-medium">{job.title}</span>
        <span className="text-xs text-muted-foreground">r{job.round}</span>
        <StateBadge state={job.state} />
        {job.agent_name && (
          <Badge variant="outline" className="text-xs">
            {job.agent_name}
          </Badge>
        )}
        {job.assignee_user_id && (
          <span className="text-xs text-muted-foreground">→ {job.assignee_user_id}</span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {job.state === "todo" && (
            <Button type="button" variant="ghost" size="sm" onClick={claim}>
              {L("Claim")}
            </Button>
          )}
          {job.state === "in_progress" && !job.session_id && (
            <Button type="button" variant="ghost" size="sm" onClick={launch}>
              <GitBranchIcon className="size-3.5" /> {L("Launch")}
            </Button>
          )}
          {job.state === "pending_review" && (
            <Button type="button" variant="ghost" size="sm" onClick={() => setShowEvaluate(true)}>
              <ThumbsUpIcon className="size-3.5" /> {L("Evaluate")}
            </Button>
          )}
          <Button type="button" variant="ghost" size="sm" onClick={() => setShowCreate(true)}>
            <PlusIcon className="size-3.5" />
          </Button>
        </div>
      </div>
      {job.artifacts && job.artifacts.length > 0 && (
        <div className="pl-8 text-xs text-muted-foreground" style={indent}>
          {job.artifacts.map((a) => (
            <div key={a.id} className="flex gap-1">
              <span className="font-medium">{a.artifact_type}:</span>
              <span className="truncate">{a.summary ?? a.ref}</span>
            </div>
          ))}
        </div>
      )}
      {job.evaluations && job.evaluations.length > 0 && (
        <div className="pl-8 text-xs" style={indent}>
          {job.evaluations.map((e) => (
            <div key={e.id} className="flex gap-1">
              <span className={e.action === "pass" ? "text-green-600" : "text-red-600"}>
                {e.action === "pass" ? "✅" : "❌"}
              </span>
              <span className="text-muted-foreground">
                {e.evaluator_user_id ?? "?"}: {e.comment}
              </span>
            </div>
          ))}
        </div>
      )}
      {showEvaluate && (
        <div className="mt-1" style={indent}>
          <EvaluateForm job={job} onDone={() => setShowEvaluate(false)} />
        </div>
      )}
      {showCreate && (
        <div className="mt-1" style={indent}>
          <CreateJobForm
            onDone={() => {
              setShowCreate(false);
              queryClient.invalidateQueries({ queryKey: ["jobs"] });
            }}
          />
        </div>
      )}
      {job.children && job.children.length > 0 && (
        <div>
          {job.children.map((c) => (
            <JobNode key={c.id} job={c} depth={depth + 1} />
          ))}
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
  const [showCreate, setShowCreate] = useState(false);
  const {
    data: jobs = [],
    isLoading,
    error,
  } = useQuery({
    queryKey: ["jobs", refreshKey],
    queryFn: async () => {
      const res = await authenticatedFetch("/v1/jobs");
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

  return (
    <section className="p-4">
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
        </div>
      </div>

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
        <div className="mt-4">
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

      <div className="mt-4 space-y-2">
        {jobs.map((j) => (
          <Card key={j.id} className="p-2">
            <JobNode job={j} />
          </Card>
        ))}
      </div>
    </section>
  );
}
