import { useCallback, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BookOpenIcon,
  DownloadIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
} from "lucide-react";
import { authenticatedFetch } from "@/lib/identity";
import { L } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

/** Wire shape of GET /v1/skills. */
interface InstalledSkillWire {
  slug?: string | null;
  name?: string | null;
  version?: string | null;
  agent?: string | null;
  registry?: string | null;
  installed_at?: string | null;
  installed_by?: string | null;
  target?: string | null;
}

const DEFAULT_REGISTRY = "http://192.168.10.86:4011";

async function fetchSkills(): Promise<InstalledSkillWire[]> {
  const res = await authenticatedFetch("/v1/skills");
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const body = (await res.json()) as { skills: InstalledSkillWire[] };
  return body.skills;
}

/** Install form: slug (namespace/name) + optional agent target. */
function InstallForm({ onDone }: { onDone: () => void }) {
  const [slug, setSlug] = useState("");
  const [agent, setAgent] = useState("");
  const [registry, setRegistry] = useState(DEFAULT_REGISTRY);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const install = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const payload: Record<string, unknown> = { slug: slug.trim(), registry: registry.trim() };
      if (agent.trim()) payload.agent = agent.trim();
      const res = await authenticatedFetch("/v1/skills/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error((body as { error?: string })?.error ?? `${res.status}`);
      }
      await queryClient.invalidateQueries({ queryKey: ["skills"] });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [slug, agent, registry, onDone, queryClient]);

  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">{L("Install skill from SkillHub")}</span>
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>
          ✕
        </Button>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <label className="space-y-1">
          <span className="text-sm">{L("Skill slug")}</span>
          <Input
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            placeholder="cwr/ssh-server-ops"
          />
        </label>
        <label className="space-y-1">
          <span className="text-sm">{L("Target agent (optional)")}</span>
          <Input
            value={agent}
            onChange={(e) => setAgent(e.target.value)}
            placeholder="backend"
          />
        </label>
        <label className="space-y-1 sm:col-span-2">
          <span className="text-sm">{L("Registry URL")}</span>
          <Input
            value={registry}
            onChange={(e) => setRegistry(e.target.value)}
            placeholder={DEFAULT_REGISTRY}
          />
        </label>
      </div>

      <p className="text-xs text-muted-foreground">
        {L("Install into an agent bundle (e.g. backend) or globally when no agent is given.")}
      </p>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex justify-end">
        <Button type="button" size="sm" disabled={saving || !slug.trim()} onClick={install}>
          {saving ? L("Installing…") : L("Install")}
        </Button>
      </div>
    </Card>
  );
}

/**
 * Skill coordination page (Settings → Skills).
 *
 * Omnigent does not host skill content — skills are downloaded from a
 * SkillHub registry and materialized into an agent bundle or the global
 * skill dir. This page lists installed skills (records) and offers an
 * install / remove UI that talks to the server's coordination API.
 */
export function SkillsPage() {
  const [refreshKey, setRefreshKey] = useState(0);
  const [showForm, setShowForm] = useState(false);
  const {
    data: skills = [],
    isLoading,
    error,
  } = useQuery({
    queryKey: ["skills", refreshKey],
    queryFn: fetchSkills,
    staleTime: 10_000,
  });
  const queryClient = useQueryClient();

  const sorted = useMemo(
    () => [...skills].sort((a, b) => (a.slug ?? "").localeCompare(b.slug ?? "")),
    [skills],
  );

  const remove = useCallback(
    async (s: InstalledSkillWire) => {
      if (!window.confirm(`${L("Uninstall")} ${s.slug}?`)) return;
      const res = await authenticatedFetch("/v1/skills/remove", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: s.slug, agent: s.agent ?? null }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        alert((body as { error?: string })?.error ?? `${res.status}`);
        return;
      }
      await queryClient.invalidateQueries({ queryKey: ["skills"] });
    },
    [queryClient],
  );

  return (
    <section>
      <h1 className="text-2xl font-semibold">{L("Skills")}</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        {L("Install skills from a SkillHub registry into agents or globally.")}
      </p>

      <div className="mt-6 flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setRefreshKey((k) => k + 1)}
        >
          <RefreshCwIcon className="size-3.5" />
          {L("Refresh")}
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={() => setShowForm((v) => !v)}
        >
          <PlusIcon className="size-3.5" />
          {L("Install skill")}
        </Button>
      </div>

      {showForm && (
        <div className="mt-4">
          <InstallForm onDone={() => setShowForm(false)} />
        </div>
      )}

      {isLoading && <p className="mt-4 text-sm text-muted-foreground">{L("Loading…")}</p>}
      {error && (
        <p className="mt-4 text-sm text-destructive">
          {L("Failed to load:")} {String(error)}
        </p>
      )}

      {!isLoading && !error && sorted.length === 0 && (
        <p className="mt-4 text-sm text-muted-foreground">{L("No skills installed")}</p>
      )}

      <div className="mt-4 space-y-2">
        {sorted.map((s) => (
          <Card key={`${s.slug}-${s.agent ?? "global"}`} className="flex items-center justify-between gap-2 p-3">
            <div className="flex min-w-0 items-center gap-2">
              <BookOpenIcon className="size-4 shrink-0 text-muted-foreground" />
              <span className="truncate font-medium">{s.slug}</span>
              {s.agent ? (
                <Badge>{s.agent}</Badge>
              ) : (
                <Badge variant="outline">{L("Global")}</Badge>
              )}
              {s.version && s.version !== "latest" && (
                <Badge variant="outline">v{s.version}</Badge>
              )}
              <span className="truncate text-xs text-muted-foreground">
                {s.registry ?? ""} · {s.installed_at ?? ""}
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Button type="button" variant="ghost" size="sm" onClick={() => remove(s)}>
                <Trash2Icon className="size-3.5" />
              </Button>
            </div>
          </Card>
        ))}
      </div>

      <div className="mt-6 flex items-start gap-2 rounded-md border p-3 text-xs text-muted-foreground">
        <DownloadIcon className="mt-0.5 size-3.5 shrink-0" />
        <span>
          {L("Tip: use the skillhub CLI to install skills directly to your machine's harness directories.")}
          <code className="mx-1 rounded bg-muted px-1">skillhub install &lt;name&gt; --namespace &lt;ns&gt;</code>
        </span>
      </div>
    </section>
  );
}
