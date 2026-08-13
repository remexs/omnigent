import { useCallback, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CpuIcon, PlusIcon, RefreshCwIcon, Trash2Icon, XIcon } from "lucide-react";
import { authenticatedFetch } from "@/lib/identity";
import { L } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

/** Wire shape of GET /v1/providers. */
interface ProviderFamilyWire {
  base_url?: string | null;
  api_key_ref?: string | null;
  models?: Record<string, string>;
  wire_api?: string | null;
}
interface ProviderWire {
  name: string;
  kind: string;
  families: Record<string, ProviderFamilyWire>;
  cli?: string | null;
  profile?: string | null;
  model_provider?: string | null;
  default_families?: string[];
}

const FAMILY_LABELS: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  gemini: "Gemini",
};

async function fetchProviders(): Promise<ProviderWire[]> {
  const res = await authenticatedFetch("/v1/providers");
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const body = (await res.json()) as { providers: ProviderWire[] };
  return body.providers;
}

function familySummary(p: ProviderWire): string {
  const parts = Object.entries(p.families).map(([fam, f]) => {
    const label = FAMILY_LABELS[fam] ?? fam;
    const model = f.models?.default ? ` / ${f.models.default}` : "";
    return `${label}${model}`;
  });
  return parts.join(" · ") || "—";
}

/** Add/edit provider form. */
function ProviderForm({ initial, onDone }: { initial?: ProviderWire | null; onDone: () => void }) {
  const [name, setName] = useState(initial?.name ?? "");
  const [kind, setKind] = useState(initial?.kind ?? "key");
  const [family, setFamily] = useState(
    initial && Object.keys(initial.families)[0] ? Object.keys(initial.families)[0] : "openai",
  );
  const [baseUrl, setBaseUrl] = useState(initial?.families[family]?.base_url ?? "");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(initial?.families[family]?.models?.default ?? "");
  const [isDefault, setIsDefault] = useState((initial?.default_families?.length ?? 0) > 0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const isEdit = Boolean(initial);

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const payload: Record<string, unknown> = {
        name: name.trim(),
        kind,
        family,
        base_url: baseUrl.trim(),
        model: model.trim(),
        default: isDefault,
      };
      if (apiKey.trim()) payload.api_key = apiKey.trim();
      const method = isEdit ? "PUT" : "POST";
      const url = isEdit ? `/v1/providers/${encodeURIComponent(initial!.name)}` : "/v1/providers";
      const res = await authenticatedFetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        // The API returns {"error":{"code":...,"message":...}} — surface the
        // message instead of the raw object (which stringifies to "[object Object]").
        const apiErr = (body as { error?: { message?: string } | string })?.error;
        const message = typeof apiErr === "string" ? apiErr : apiErr?.message;
        throw new Error(message ?? `${res.status}`);
      }
      await queryClient.invalidateQueries({ queryKey: ["providers"] });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [kind, family, baseUrl, model, isDefault, apiKey, isEdit, initial, onDone, queryClient]);

  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">
          {isEdit ? L("Edit provider") : L("New provider")}
        </span>
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>
          <XIcon className="size-3.5" />
        </Button>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <label className="space-y-1">
          <span className="text-sm">{L("Name")}</span>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={isEdit}
            placeholder="my-provider"
          />
        </label>
        <label className="space-y-1">
          <span className="text-sm">{L("Kind")}</span>
          <select
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
            value={kind}
            onChange={(e) => setKind(e.target.value)}
          >
            <option value="key">key</option>
            <option value="gateway">gateway</option>
            <option value="local">local</option>
          </select>
        </label>
        <label className="space-y-1">
          <span className="text-sm">{L("Family")}</span>
          <select
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
            value={family}
            onChange={(e) => setFamily(e.target.value)}
          >
            <option value="openai">OpenAI</option>
            <option value="anthropic">Anthropic</option>
            <option value="gemini">Gemini</option>
          </select>
        </label>
        <label className="space-y-1">
          <span className="text-sm">{L("Base URL")}</span>
          <Input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.example.com/v1"
          />
        </label>
        <label className="space-y-1">
          <span className="text-sm">{L("API key")}</span>
          <Input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={isEdit ? "••••••••" : ""}
          />
        </label>
        <label className="space-y-1">
          <span className="text-sm">{L("Default model")}</span>
          <Input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="deepseek-v4-flash"
          />
        </label>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={isDefault}
          onChange={(e) => setIsDefault(e.target.checked)}
        />
        {L("Default provider")}
      </label>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex justify-end">
        <Button type="button" size="sm" disabled={saving || !name.trim()} onClick={save}>
          {saving ? L("Saving…") : L("Save")}
        </Button>
      </div>
    </Card>
  );
}

/**
 * Model provider management (Settings → Model providers).
 *
 * Visual CRUD for the ``providers:`` block of ``~/.omnigent/config.yaml``:
 * add OpenAI-compatible endpoints (base_url + key + default model) that pi /
 * goose / codex / claude-sdk harnesses use. Fills the gap where only
 * hand-editing YAML or `omnigent setup` (preset-only) existed before.
 */
export function ProvidersPage() {
  const [refreshKey, setRefreshKey] = useState(0);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<ProviderWire | null>(null);
  const {
    data: providers = [],
    isLoading,
    error,
  } = useQuery({
    queryKey: ["providers", refreshKey],
    queryFn: fetchProviders,
    staleTime: 10_000,
  });
  const queryClient = useQueryClient();

  const sorted = useMemo(
    () => [...providers].sort((a, b) => a.name.localeCompare(b.name)),
    [providers],
  );

  const remove = useCallback(
    async (name: string) => {
      if (!window.confirm(`${L("Delete")} ${name}?`)) return;
      const res = await authenticatedFetch(`/v1/providers/${encodeURIComponent(name)}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        alert((body as { error?: string })?.error ?? `${res.status}`);
        return;
      }
      await queryClient.invalidateQueries({ queryKey: ["providers"] });
    },
    [queryClient],
  );

  return (
    <section>
      <h1 className="text-2xl font-semibold">{L("Model providers")}</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        {L("Configure OpenAI-compatible endpoints used by pi, goose, codex, and claude-sdk.")}
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
          onClick={() => {
            setEditing(null);
            setShowForm(true);
          }}
        >
          <PlusIcon className="size-3.5" />
          {L("New provider")}
        </Button>
      </div>

      {showForm && (
        <div className="mt-4">
          <ProviderForm
            initial={editing}
            onDone={() => {
              setShowForm(false);
              setEditing(null);
            }}
          />
        </div>
      )}

      {isLoading && <p className="mt-4 text-sm text-muted-foreground">{L("Loading…")}</p>}
      {error && (
        <p className="mt-4 text-sm text-destructive">
          {L("Failed to load:")} {String(error)}
        </p>
      )}

      {!isLoading && !error && sorted.length === 0 && (
        <p className="mt-4 text-sm text-muted-foreground">{L("No providers configured")}</p>
      )}

      <div className="mt-4 space-y-2">
        {sorted.map((p) => (
          <div
            key={p.name}
            className="flex items-center justify-between gap-2 rounded-xl bg-card p-3 text-sm text-card-foreground ring-1 ring-foreground/10 shadow-sm"
          >
            <div className="flex min-w-0 items-center gap-2">
              <CpuIcon className="size-4 shrink-0 text-muted-foreground" />
              <span className="truncate font-medium">{p.name}</span>
              <Badge variant="outline">{p.kind}</Badge>
              {(p.default_families?.length ?? 0) > 0 && <Badge>{L("Default")}</Badge>}
              <span className="truncate text-xs text-muted-foreground">{familySummary(p)}</span>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setEditing(p);
                  setShowForm(true);
                }}
              >
                {L("Edit")}
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => remove(p.name)}>
                <Trash2Icon className="size-3.5" />
              </Button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
