import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { RefreshCwIcon, ServerIcon, CheckIcon, AlertTriangleIcon } from "lucide-react";
import { authenticatedFetch } from "@/lib/identity";
import { L } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";

/** Wire shape of GET /v1/hosts. */
interface HostWire {
  host_id: string;
  name: string;
  status: string;
  owner?: string;
  sandbox_provider?: string | null;
  configured_harnesses?: Record<string, boolean | string> | null;
}

interface HostsListWire {
  hosts: HostWire[];
}

async function fetchHosts(): Promise<HostWire[]> {
  const res = await authenticatedFetch("/v1/hosts");
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const body = (await res.json()) as HostsListWire;
  return body.hosts ?? [];
}

/** Human label for a harness readiness value. */
function harnessStatus(v: boolean | string): { label: string; kind: "ok" | "no" | "warn" } {
  if (v === true) return { label: L("Available"), kind: "ok" };
  if (v === false) return { label: L("Not installed"), kind: "no" };
  if (v === "binary-missing") return { label: L("Binary missing"), kind: "warn" };
  if (v === "needs-auth") return { label: L("Needs auth"), kind: "warn" };
  if (v === "version-too-low") return { label: L("Version too low"), kind: "warn" };
  return { label: String(v), kind: "warn" };
}

function HostCard({ host }: { host: HostWire }) {
  const [open, setOpen] = useState(false);
  const harnesses = host.configured_harnesses ?? {};

  // Only harnesses the machine actually has (installed or needs
  // attention) are shown; `false` / not-present entries are omitted.
  const ok: string[] = [];
  const warn: string[] = [];
  for (const [name, v] of Object.entries(harnesses)) {
    if (v === true) ok.push(name);
    else if (typeof v === "string") warn.push(name);
  }

  const online = host.status === "online";

  return (
    <Card className="p-4">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-2 text-left"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="flex min-w-0 items-center gap-2">
          <ServerIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate font-medium">{host.name}</span>
          <Badge variant={online ? "default" : "secondary"}>
            {online ? L("Online") : L("Offline")}
          </Badge>
          {host.owner && host.owner !== "local" && (
            <span className="truncate text-xs text-muted-foreground">({host.owner})</span>
          )}
        </span>
        <span className="text-xs text-muted-foreground">
          {L("Harnesses")}: {ok.length} {L("available")}
        </span>
      </button>

      {open && (
        <div className="mt-3 space-y-3">
          <div>
            <div className="mb-1 text-sm font-medium">
              {L("Available harnesses")} ({ok.length})
            </div>
            <div className="flex flex-wrap gap-1.5">
              {ok.length === 0 && (
                <span className="text-xs text-muted-foreground">{L("None")}</span>
              )}
              {ok.map((h) => (
                <Badge key={h} variant="outline" className="gap-1">
                  <CheckIcon className="size-3 text-emerald-500" />
                  {h}
                </Badge>
              ))}
            </div>
          </div>

          {warn.length > 0 && (
            <div>
              <div className="mb-1 text-sm font-medium">
                {L("Needs attention")} ({warn.length})
              </div>
              <div className="flex flex-wrap gap-1.5">
                {warn.map((h) => {
                  const s = harnessStatus(harnesses[h]);
                  return (
                    <Badge key={h} variant="outline" className="gap-1">
                      <AlertTriangleIcon className="size-3 text-amber-500" />
                      {h} · {s.label}
                    </Badge>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

/**
 * Hosts management (Settings → Hosts).
 *
 * Lists every machine registered as a host on this server and the
 * harnesses each one actually joined (installed & usable, or installed
 * but needing auth / a newer binary). Harnesses the machine does NOT
 * have are deliberately hidden — they can't be scheduled here anyway,
 * and showing them would clutter the picker. Harness installation is
 * decided per machine by its owner; the server only observes and
 * schedules.
 */
export function HostsPage() {
  const [refreshKey, setRefreshKey] = useState(0);
  const {
    data: hosts = [],
    isLoading,
    error,
  } = useQuery({
    queryKey: ["hosts", refreshKey],
    queryFn: fetchHosts,
    staleTime: 10_000,
  });

  const sorted = useMemo(() => [...hosts].sort((a, b) => a.name.localeCompare(b.name)), [hosts]);

  return (
    <section>
      <h1 className="text-2xl font-semibold">{L("Hosts")}</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        {L("Machines registered as hosts on this server and the harnesses they joined.")}
      </p>

      <div className="mt-6 flex items-center justify-end">
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

      {isLoading && <p className="mt-4 text-sm text-muted-foreground">{L("Loading…")}</p>}
      {error && (
        <p className="mt-4 text-sm text-destructive">
          {L("Failed to load:")} {String(error)}
        </p>
      )}

      {!isLoading && !error && sorted.length === 0 && (
        <p className="mt-4 text-sm text-muted-foreground">{L("No hosts connected yet")}</p>
      )}

      <div className="mt-4 space-y-2">
        {sorted.map((h) => (
          <HostCard key={h.host_id} host={h} />
        ))}
      </div>
    </section>
  );
}
