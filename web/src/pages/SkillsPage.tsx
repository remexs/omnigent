import { useCallback, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BookOpenIcon,
  DownloadIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  Trash2Icon,
  XIcon,
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
  summary?: string | null;
  version?: string | null;
  agent?: string | null;
  registry?: string | null;
  installed_at?: string | null;
  installed_by?: string | null;
  target?: string | null;
}

/** Wire shape of GET /v1/skills/detail. */
interface SkillDetailWire {
  slug?: string | null;
  agent?: string | null;
  target?: string | null;
  frontmatter?: Record<string, unknown>;
  body?: string | null;
  files?: string[];
  installed_at?: string | null;
}

/** Wire shape of GET /v1/skills/registry (SkillHub proxy). */
interface RegistrySkillWire {
  slug?: string;
  name?: string;
  summary?: string;
  version?: string | null;
  stats?: { downloads?: number; stars?: number };
}

async function fetchSkills(): Promise<InstalledSkillWire[]> {
  const res = await authenticatedFetch("/v1/skills");
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const body = (await res.json()) as { skills: InstalledSkillWire[] };
  return body.skills;
}

async function fetchRegistrySkills(q: string): Promise<RegistrySkillWire[]> {
  const params = new URLSearchParams({ q });
  const res = await authenticatedFetch(`/v1/skills/registry?${params.toString()}`);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const body = (await res.json()) as { skills: RegistrySkillWire[] };
  return body.skills;
}

async function fetchSkillDetail(slug: string, agent: string | null): Promise<SkillDetailWire> {
  const params = new URLSearchParams({ slug });
  if (agent) params.set("agent", agent);
  const res = await authenticatedFetch(`/v1/skills/detail?${params.toString()}`);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as SkillDetailWire;
}

/** Inline detail panel for an installed skill (SKILL.md + files). */
function SkillDetail({ skill, onClose }: { skill: InstalledSkillWire; onClose: () => void }) {
  const [showBody, setShowBody] = useState(false);
  const {
    data: detail,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["skill-detail", skill.slug, skill.agent ?? null],
    queryFn: () => fetchSkillDetail(skill.slug ?? "", skill.agent ?? null),
    staleTime: 30_000,
  });

  const fm = detail?.frontmatter ?? {};
  const fmEntries = Object.entries(fm).filter(([k]) => k !== "metadata");
  const metadata = fm.metadata as Record<string, unknown> | undefined;

  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="font-medium">{skill.slug}</span>
          {skill.agent ? <Badge>{skill.agent}</Badge> : <Badge variant="outline">{L("Global")}</Badge>}
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          <XIcon className="size-3.5" />
        </Button>
      </div>

      {isLoading && <p className="text-sm text-muted-foreground">{L("Loading…")}</p>}
      {error && <p className="text-sm text-destructive">{L("Failed to load:")} {String(error)}</p>}
      {detail && (
        <>
          {detail.target && (
            <p className="text-xs text-muted-foreground">
              <code className="rounded bg-muted px-1">{detail.target}</code>
            </p>
          )}

          {fmEntries.length > 0 && (
            <div className="grid gap-1 rounded-md border p-2 text-xs sm:grid-cols-2">
              {fmEntries.map(([k, v]) => (
                <div key={k} className="flex gap-1">
                  <span className="font-medium">{k}:</span>
                  <span className="truncate text-muted-foreground">{String(v)}</span>
                </div>
              ))}
            </div>
          )}

          {metadata && (
            <div className="rounded-md border p-2 text-xs">
              <span className="font-medium">{L("Metadata")}:</span>{" "}
              <span className="text-muted-foreground">{JSON.stringify(metadata)}</span>
            </div>
          )}

          {detail.body && (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setShowBody((v) => !v)}
              >
                {showBody ? L("Hide instructions") : L("Show instructions")}
              </Button>
              {showBody && (
                <pre className="max-h-72 overflow-auto rounded-md border bg-muted/40 p-3 text-xs whitespace-pre-wrap">
                  {detail.body}
                </pre>
              )}
            </>
          )}

          {detail.files && detail.files.length > 0 && (
            <div className="space-y-0.5">
              <span className="text-xs font-medium">{L("Files")}:</span>
              <div className="flex flex-wrap gap-1">
                {detail.files.map((f) => (
                  <code key={f} className="rounded bg-muted px-1 py-0.5 text-xs">
                    {f}
                  </code>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

/** Pick a skill from the SkillHub registry, then choose the target agent. */
function InstallDialog({
  initialSlug,
  onDone,
}: {
  initialSlug?: string;
  onDone: () => void;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<RegistrySkillWire | null>(
    initialSlug ? { slug: initialSlug } : null,
  );
  const [agent, setAgent] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const {
    data: registrySkills = [],
    isLoading: browsing,
    error: browseError,
  } = useQuery({
    queryKey: ["skills-registry", query],
    queryFn: () => fetchRegistrySkills(query),
    staleTime: 30_000,
  });

  const install = useCallback(async () => {
    if (!selected?.slug) return;
    setSaving(true);
    setError(null);
    try {
      const payload: Record<string, unknown> = { slug: selected.slug };
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
  }, [selected, agent, onDone, queryClient]);

  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">{L("Install skill from SkillHub")}</span>
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>
          <XIcon className="size-3.5" />
        </Button>
      </div>

      {/* Step 1: pick a skill from the registry */}
      <div className="space-y-1">
        <span className="text-sm">{L("Search SkillHub")}</span>
        <div className="relative">
          <SearchIcon className="absolute left-2.5 top-2.5 size-3.5 text-muted-foreground" />
          <Input
            className="pl-8"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={L("Search skills…")}
          />
        </div>
      </div>

      {browsing && <p className="text-sm text-muted-foreground">{L("Loading…")}</p>}
      {browseError && (
        <p className="text-sm text-destructive">
          {L("Failed to load:")} {String(browseError)}
        </p>
      )}

      <div className="max-h-56 space-y-1 overflow-y-auto rounded-md border p-1">
        {registrySkills.length === 0 && !browsing && !browseError && (
          <p className="p-2 text-sm text-muted-foreground">{L("No skills found")}</p>
        )}
        {registrySkills.map((s) => (
          <button
            key={s.slug}
            type="button"
            onClick={() => setSelected(s)}
            className={`w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent ${
              selected?.slug === s.slug ? "bg-accent" : ""
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="truncate font-medium">{s.slug}</span>
              {s.version && <Badge variant="outline">v{s.version}</Badge>}
            </div>
            {s.summary && (
              <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">{s.summary}</p>
            )}
          </button>
        ))}
      </div>

      {/* Step 2: choose target */}
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="space-y-1">
          <span className="text-sm">{L("Selected skill")}</span>
          <Input value={selected?.slug ?? ""} readOnly placeholder="—" />
        </label>
        <label className="space-y-1">
          <span className="text-sm">{L("Target agent (optional)")}</span>
          <Input
            value={agent}
            onChange={(e) => setAgent(e.target.value)}
            placeholder="backend"
          />
        </label>
      </div>

      <p className="text-xs text-muted-foreground">
        {L("Install into an agent bundle (e.g. backend) or globally when no agent is given.")}
      </p>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex justify-end">
        <Button type="button" size="sm" disabled={saving || !selected?.slug} onClick={install}>
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
 * skill dir. This page lists installed skills (records), lets the user
 * browse the SkillHub registry and install by picking from the list
 * (no hand-typed slugs), and remove installed skills.
 */
export function SkillsPage() {
  const [refreshKey, setRefreshKey] = useState(0);
  const [showInstall, setShowInstall] = useState(false);
  const [detailSkill, setDetailSkill] = useState<InstalledSkillWire | null>(null);
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
        <Button type="button" size="sm" onClick={() => setShowInstall((v) => !v)}>
          <PlusIcon className="size-3.5" />
          {L("Install skill")}
        </Button>
      </div>

      {showInstall && (
        <div className="mt-4">
          <InstallDialog onDone={() => setShowInstall(false)} />
        </div>
      )}

      {detailSkill && (
        <div className="mt-4">
          <SkillDetail skill={detailSkill} onClose={() => setDetailSkill(null)} />
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
          <Card
            key={`${s.slug}-${s.agent ?? "global"}`}
            className="flex cursor-pointer items-center justify-between gap-2 p-3 hover:bg-accent/50"
            onClick={() => setDetailSkill(s)}
          >
            <div className="flex min-w-0 items-center gap-2">
              <BookOpenIcon className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium">{s.slug}</span>
                  {s.agent ? (
                    <Badge>{s.agent}</Badge>
                  ) : (
                    <Badge variant="outline">{L("Global")}</Badge>
                  )}
                  {s.version && s.version !== "latest" && (
                    <Badge variant="outline">v{s.version}</Badge>
                  )}
                </div>
                {s.summary && (
                  <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{s.summary}</p>
                )}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={(e) => {
                  e.stopPropagation();
                  remove(s);
                }}
              >
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
