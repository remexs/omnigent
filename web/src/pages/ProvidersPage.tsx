import { useCallback, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CpuIcon, DownloadIcon, PlusIcon, RefreshCwIcon, Trash2Icon, XIcon } from "lucide-react";
import { authenticatedFetch } from "@/lib/identity";
import { isElectronShell, writeLocalProvider } from "@/lib/nativeBridge";
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
  /** "server" = shared on the coordinating server; "local" = this machine. */
  scope?: "server" | "local";
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
  const server = (body.providers ?? []).map((p) => ({ ...p, scope: "server" as const }));
  // Under the desktop shell, ALSO load this machine's own providers from
  // ~/.omnigent/config.yaml so local + shared show side by side (the
  // "server schedules, host executes" model — both belong to the page).
  if (isElectronShell()) {
    const local = await readLocalProviders();
    const localNames = new Set(local.map((p) => String(p.name)));
    return [...local.map((p) => ({ ...p, scope: "local" as const })), ...server.filter((p) => !localNames.has(p.name))];
  }
  return server;
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
  // Where the provider lives: "server" = shared on the coordinating server;
  // "local" = this machine's own ~/.omnigent/config.yaml (host executes with it).
  const [scope, setScope] = useState<"server" | "local">("local");
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
      if (scope === "local") {
        // Local provider: write THIS machine's ~/.omnigent/config.yaml via the
        // desktop shell (host executes agents with it — server only schedules).
        const nameStr = name.trim();
        const localRes = await writeLocalProvider(nameStr, {
          kind,
          family,
          base_url: baseUrl.trim() || undefined,
          api_key: apiKey.trim() || undefined,
          model: model.trim() || undefined,
        });
        if (!localRes.ok) throw new Error(localRes.error ?? "failed to write local provider");
        onDone();
        return;
      }
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
  }, [kind, family, baseUrl, model, isDefault, apiKey, scope, isEdit, initial, onDone, queryClient]);

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
          <span className="text-sm">{L("Storage")}</span>
          <select
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
            value={scope}
            onChange={(e) => setScope(e.target.value as "server" | "local")}
            data-testid="provider-scope-select"
          >
            <option value="local">{L("This machine (local execution)")}</option>
            <option value="server">{L("Server (shared model)")}</option>
          </select>
          <p className="text-xs text-muted-foreground">
            {L("Local providers are stored on this machine's host config; server providers are shared by the coordinating server.")}
          </p>
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
    async (p: ProviderWire) => {
      if (!window.confirm(`${L("Delete")} ${p.name}?`)) return;
      if (p.scope === "local") {
        // Local provider: remove from this machine's config.yaml via IPC.
        const res = await writeLocalProvider(p.name, null);
        if (!res.ok) {
          alert(res.error ?? "failed to delete local provider");
          return;
        }
        await queryClient.invalidateQueries({ queryKey: ["providers"] });
        return;
      }
      const res = await authenticatedFetch(`/v1/providers/${encodeURIComponent(p.name)}`, {
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

  // Pull a SERVER (shared) provider down into this machine's
  // ~/.omnigent/config.yaml so the local host runner can execute with it.
  // Manual, user-initiated sync — no automatic push (server schedules,
  // host executes; each host owns its model providers).
  const syncToLocal = useCallback(
    async (p: ProviderWire) => {
      const fam = Object.keys(p.families)[0];
      const f = fam ? p.families[fam] : undefined;
      if (!fam || !f) {
        alert(L("This provider has no family block to sync."));
        return;
      }
      // The server API redacts api keys; if the shared provider has a key
      // we can't see, ask the user to paste it for the local copy.
      let apiKey: string | undefined = f.api_key_ref ?? undefined;
      // api_key_ref === null means the server HAS a key but hides it from the
      // API. Prompt the user to paste it for the local copy (blank skips).
      if (!apiKey) {
        const entered = window.prompt(
          L("This provider's API key is hidden on the server. Paste it to enable local execution (leave blank to skip):"),
          "",
        );
        if (entered === null) return; // user cancelled
        apiKey = entered.trim() || undefined;
      }
      const res = await writeLocalProvider(p.name, {
        kind: p.kind,
        family: fam,
        base_url: f.base_url ?? undefined,
        api_key: apiKey,
        model: f.models?.default ?? undefined,
        wire_api: f.wire_api ?? undefined,
      });
      if (!res.ok) alert(res.error ?? "failed to sync provider to this machine");
    },
    [],
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
              {p.scope === "local" ? (
                <Badge variant="secondary">{L("Local")}</Badge>
              ) : (
                <Badge variant="outline">{L("Shared")}</Badge>
              )}
              <Badge variant="outline">{p.kind}</Badge>
              {(p.default_families?.length ?? 0) > 0 && <Badge>{L("Default")}</Badge>}
              <span className="truncate text-xs text-muted-foreground">{familySummary(p)}</span>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {isElectronShell() && p.scope === "server" && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => void syncToLocal(p)}
                  title={L("Copy this shared provider to this machine's host config")}
                >
                  <DownloadIcon className="size-3.5" />
                  {L("Sync to this machine")}
                </Button>
              )}
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
              <Button type="button" variant="ghost" size="sm" onClick={() => remove(p)}>
                <Trash2Icon className="size-3.5" />
              </Button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
