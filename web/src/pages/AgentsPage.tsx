import { useCallback, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BotIcon, RefreshCwIcon, Trash2Icon, ChevronDownIcon } from "lucide-react";
import { authenticatedFetch } from "@/lib/identity";
import { L } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";

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
function AgentDetailCard({ agent }: { agent: ManagedAgent }) {
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

          {error && <p className="text-sm text-destructive">{error}</p>}

          <div className="flex flex-wrap items-center justify-end gap-2">
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
          </div>
        </div>
      )}
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
  const others = useMemo(() => sorted.filter((a) => !a.is_orchestrator), [sorted]);

  return (
    <Section
      title={L("Agents")}
      description={L("Agents registered on this server. Expand one to view or edit its config.")}
    >
      <div className="mb-4 flex items-center justify-end">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setRefreshKey((k) => k + 1)}
        >
          <RefreshCwIcon className="size-3.5" />
          {L("Refresh")}
        </Button>
      </div>

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

      {others.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-medium">{L("Other agents")}</h3>
          {others.map((a) => (
            <AgentDetailCard key={a.id} agent={a} />
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
