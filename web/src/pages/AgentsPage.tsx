import { useCallback, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BotIcon, PlusIcon, RefreshCwIcon, Trash2Icon, ChevronDownIcon, XIcon } from "lucide-react";
import { authenticatedFetch } from "@/lib/identity";
import { L } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";

/**
 * Server-registered agent with management fields.
 * Shape from GET /v1/agents (extended by the agents-management API).
 */
export interface ManagedAgent {
  id: string;
  name: string;
  description?: string | null;
  harness?: string | null;
  builtin?: boolean;
  created_at?: number | null;
  updated_at?: number | null;
  // Management-view fields.
  spawn?: boolean;
  sub_agents?: string[];
  executor_harness?: string | null;
  config_yaml?: string | null;
  is_orchestrator?: boolean;
}

interface AgentsListWire {
  data: ManagedAgent[];
  has_more?: boolean;
}

async function fetchAgents(): Promise<ManagedAgent[]> {
  const res = await authenticatedFetch("/v1/agents?limit=200");
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const body = (await res.json()) as AgentsListWire;
  return body.data;
}

async function deleteAgent(id: string): Promise<void> {
  const res = await authenticatedFetch(`/v1/agents/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
}

function formatTs(ts?: number | null): string {
  if (!ts) return "—";
  try {
    return new Date(ts * 1000).toLocaleString();
  } catch {
    return String(ts);
  }
}

/** Expandable detail card for one agent: metadata + editable config. */
function AgentDetailCard({ agent, readonly = false }: { agent: ManagedAgent; readonly?: boolean }) {
  const [open, setOpen] = useState(false);
  const [yaml, setYaml] = useState(agent.config_yaml ?? "");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const queryClient = useQueryClient();

  const saveYaml = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await authenticatedFetch(`/v1/agents/${encodeURIComponent(agent.id)}/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/yaml" },
        body: yaml,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error((body as { error?: string })?.error ?? `${res.status}`);
      }
      setDirty(false);
      await queryClient.invalidateQueries({ queryKey: ["managed-agents"] });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [agent.id, yaml, queryClient]);

  const onDelete = useCallback(async () => {
    if (!window.confirm(L("Delete this agent?") + ` (${agent.name})`)) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteAgent(agent.id);
      await queryClient.invalidateQueries({ queryKey: ["managed-agents"] });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setDeleting(false);
    }
  }, [agent.id, agent.name, queryClient]);

  const isBuiltin = agent.builtin === true;

  return (
    <Card className="p-4">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-2 text-left"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="flex min-w-0 items-center gap-2">
          <BotIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate font-medium">{agent.name}</span>
          {agent.is_orchestrator && <Badge variant="secondary">{L("Orchestrator")}</Badge>}
          {isBuiltin && <Badge variant="outline">{L("Built-in")}</Badge>}
        </span>
        <ChevronDownIcon
          className={`size-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div className="mt-3 space-y-3">
          <div className="grid gap-2 text-sm sm:grid-cols-2">
            <div>
              <div className="text-muted-foreground">{L("Harness")}</div>
              <div className="font-mono">{agent.executor_harness ?? agent.harness ?? "—"}</div>
            </div>
            <div>
              <div className="text-muted-foreground">{L("Spawn")}</div>
              <div>{agent.spawn ? L("Yes") : L("No")}</div>
            </div>
            <div>
              <div className="text-muted-foreground">{L("Sub-agents")}</div>
              <div className="font-mono">
                {agent.sub_agents && agent.sub_agents.length > 0
                  ? agent.sub_agents.join(", ")
                  : "—"}
              </div>
            </div>
            <div>
              <div className="text-muted-foreground">{L("Created")}</div>
              <div>{formatTs(agent.created_at)}</div>
            </div>
          </div>

          {agent.description && (
            <p className="text-sm text-muted-foreground">{agent.description}</p>
          )}

          {readonly ? (
            <div className="space-y-1.5">
              <span className="text-sm font-medium">{L("Config (YAML)")}</span>
              <pre className="min-h-40 overflow-auto rounded-md border bg-muted p-3 font-mono text-xs whitespace-pre-wrap">
                {yaml || "—"}
              </pre>
              <p className="text-xs text-muted-foreground">
                {L("Built-in agents are read-only and managed by the server.")}
              </p>
            </div>
          ) : (
          <div className="space-y-1.5">
            <span className="text-sm font-medium">{L("Config (YAML)")}</span>
            <Textarea
              id={`yaml-${agent.id}`}
              className="min-h-40 font-mono text-xs"
              value={yaml}
              onChange={(e) => {
                setYaml(e.target.value);
                setDirty(true);
              }}
            />
          </div>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}

          <div className="flex flex-wrap items-center justify-end gap-2">
            {readonly ? (
              <span className="text-xs text-muted-foreground">
                {L("Read-only built-in")}
              </span>
            ) : (
              <>
            {!isBuiltin && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={deleting}
                onClick={onDelete}
              >
                <Trash2Icon className="size-3.5" />
                {deleting ? L("Deleting…") : L("Delete")}
              </Button>
            )}
            <Button type="button" size="sm" disabled={!dirty || saving} onClick={saveYaml}>
              {saving ? L("Saving…") : L("Save")}
            </Button>
              </>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

/**
 * Visual orchestrator builder: pick a brain harness, add sub-agents,
 * and generate the agent config.yaml — registered via POST /v1/agents.
 */
function OrchestratorForm({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [brainHarness, setBrainHarness] = useState("pi");
  const [subAgents, setSubAgents] = useState<string[]>(["goose"]);
  const [prompt, setPrompt] = useState(
    "你是编排大脑。分析用户需求并拆分成任务，用 sys_session_send 派发给子 agent 执行，汇总结果回复用户。",
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const setSubAgent = (i: number, v: string) =>
    setSubAgents((prev) => prev.map((s, idx) => (idx === i ? v : s)));
  const addSubAgent = () => setSubAgents((prev) => [...prev, ""]);
  const removeSubAgent = (i: number) => setSubAgents((prev) => prev.filter((_, idx) => idx !== i));

  const buildYaml = useCallback((): string => {
    const agents = subAgents.map((s) => s.trim()).filter(Boolean);
    const lines = [
      "spec_version: 1",
      `name: ${name.trim()}`,
      `description: ${description.trim() || name.trim()}`,
      "",
      "# 编排器：分析需求、拆分任务、派发子 agent、汇总结果",
      "spawn: true",
      "",
      "executor:",
      "  type: omnigent",
      "  config:",
      `    harness: ${brainHarness}`,
      "",
    ];
    if (agents.length > 0) {
      lines.push("tools:", "  agents:");
      for (const a of agents) lines.push(`    - ${a}`);
      lines.push("");
    }
    lines.push("prompt: |");
    for (const line of prompt.split("\n")) {
      lines.push(`  ${line}`);
    }
    return lines.join("\n");
  }, [name, description, brainHarness, subAgents, prompt]);

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const yaml = buildYaml();
      // Generate a sub-agent config for each declared sub-agent.
      const subAgentsTrim = subAgents.map((s) => s.trim()).filter(Boolean);
      const sub_agents: Record<string, string> = {};
      for (const sa of subAgentsTrim) {
        sub_agents[sa] = [
          `spec_version: 1`,
          `name: ${sa}`,
          `description: 子 agent（${sa}），由编排器派发任务执行。`,
          "",
          "executor:",
          "  type: omnigent",
          "  config:",
          `    harness: ${sa}`,
          "",
          "os_env:",
          "  type: caller_process",
          "  cwd: .",
          "  sandbox:",
          "    type: none",
          "",
          "prompt: |",
          "  你是执行子 agent。接收编排器派发的单个任务，用真实工具执行，",
          "  返回结构化结果。",
        ].join("\n");
      }
      const res = await authenticatedFetch("/v1/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config_yaml: yaml, sub_agents }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error((body as { error?: string })?.error ?? `${res.status}`);
      }
      await queryClient.invalidateQueries({ queryKey: ["managed-agents"] });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [buildYaml, subAgents, onDone, queryClient]);

  const canSave = name.trim().length > 0 && subAgents.some((s) => s.trim());

  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">{L("New orchestrator")}</span>
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>
          <XIcon className="size-3.5" />
        </Button>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <label className="space-y-1">
          <span className="text-sm">{L("Name")}</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="my-workflow" />
        </label>
        <label className="space-y-1">
          <span className="text-sm">{L("Brain harness")}</span>
          <select
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
            value={brainHarness}
            onChange={(e) => setBrainHarness(e.target.value)}
          >
            <option value="pi">pi</option>
            <option value="goose">goose</option>
            <option value="opencode">opencode</option>
            <option value="claude-sdk">claude-sdk</option>
          </select>
        </label>
      </div>

      <label className="space-y-1">
        <span className="text-sm">{L("Description")}</span>
        <Input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={L("What this orchestrator does")}
        />
      </label>

      <div className="space-y-1.5">
        <span className="text-sm font-medium">{L("Sub-agents")}</span>
        {subAgents.map((s, i) => (
          // eslint-disable-next-line react/no-array-index-key
          <div key={i} className="flex items-center gap-2">
            <Input value={s} onChange={(e) => setSubAgent(i, e.target.value)} placeholder="goose" />
            <Button type="button" variant="ghost" size="sm" onClick={() => removeSubAgent(i)}>
              <XIcon className="size-3.5" />
            </Button>
          </div>
        ))}
        <Button type="button" variant="outline" size="sm" onClick={addSubAgent}>
          <PlusIcon className="size-3.5" />
          {L("Add sub-agent")}
        </Button>
      </div>

      <label className="space-y-1">
        <span className="text-sm">{L("Prompt")}</span>
        <textarea
          className="min-h-32 w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />
      </label>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex items-center justify-end gap-2">
        <Button type="button" size="sm" disabled={!canSave || saving} onClick={save}>
          {saving ? L("Saving…") : L("Create orchestrator")}
        </Button>
      </div>
    </Card>
  );
}

/**
 * Agents management section (Settings → Agents).
 *
 * Lists every built-in / operator-registered agent on the server with
 * its orchestrator shape (spawn, sub-agents, harness) and an editable
 * raw config view — the server-side counterpart to a visual workflow
 * editor.
 */
export function AgentsPage() {
  const [refreshKey, setRefreshKey] = useState(0);
  const [showForm, setShowForm] = useState(false);
  const {
    data: agents = [],
    isLoading,
    error,
  } = useQuery({
    queryKey: ["managed-agents", refreshKey],
    queryFn: fetchAgents,
    staleTime: 10_000,
  });

  const sorted = useMemo(() => [...agents].sort((a, b) => a.name.localeCompare(b.name)), [agents]);

  const orchestrators = useMemo(() => sorted.filter((a) => a.is_orchestrator), [sorted]);
  // Built-ins are server-managed and read-only — outside the maintenance
  // scope, so they render in a collapsed read-only section (or are absent
  // when there are none). Everything else is user-maintainable.
  const [showBuiltins, setShowBuiltins] = useState(false);
  const builtins = useMemo(() => sorted.filter((a) => a.builtin === true), [sorted]);
  const maintainable = useMemo(
    () => sorted.filter((a) => !a.is_orchestrator && a.builtin !== true),
    [sorted],
  );

  return (
    <Section
      title={L("Agents")}
      description={L("Agents registered on this server. Expand one to view or edit its config.")}
    >
      <div className="mb-4 flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setRefreshKey((k) => k + 1)}
        >
          <RefreshCwIcon className="size-3.5" />
          {L("Refresh")}
        </Button>
        <Button type="button" size="sm" onClick={() => setShowForm((v) => !v)}>
          <PlusIcon className="size-3.5" />
          {L("New orchestrator")}
        </Button>
      </div>

      {showForm && (
        <div className="mb-6">
          <OrchestratorForm onDone={() => setShowForm(false)} />
        </div>
      )}

      {isLoading && <p className="text-sm text-muted-foreground">{L("Loading…")}</p>}
      {error && (
        <p className="text-sm text-destructive">
          {L("Failed to load:")} {String(error)}
        </p>
      )}

      {!isLoading && !error && sorted.length === 0 && (
        <p className="text-sm text-muted-foreground">{L("No agents")}</p>
      )}

      {orchestrators.length > 0 && (
        <div className="mb-6 space-y-2">
          <h3 className="text-sm font-medium">{L("Orchestrators")}</h3>
          {orchestrators.map((a) => (
            <AgentDetailCard key={a.id} agent={a} />
          ))}
        </div>
      )}

      {maintainable.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-medium">{L("Agents")}</h3>
          {maintainable.map((a) => (
            <AgentDetailCard key={a.id} agent={a} />
          ))}
        </div>
      )}

      {builtins.length > 0 && (
        <div className="mt-6 space-y-2">
          <button
            type="button"
            className="flex w-full items-center justify-between text-sm font-medium"
            onClick={() => setShowBuiltins((v) => !v)}
          >
            <span>{L("Built-in agents")} ({builtins.length})</span>
            <ChevronDownIcon
              className={`size-4 transition-transform ${showBuiltins ? "rotate-180" : ""}`}
            />
          </button>
          {showBuiltins && builtins.map((a) => (
            <AgentDetailCard key={a.id} agent={a} readonly />
          ))}
        </div>
      )}
    </Section>
  );
}

/** Minimal section wrapper matching the settings page style. */
function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h1 className="text-2xl font-semibold">{title}</h1>
      {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      <div className="mt-6">{children}</div>
    </section>
  );
}
