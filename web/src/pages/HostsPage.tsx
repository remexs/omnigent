import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  RefreshCwIcon,
  ServerIcon,
  CheckIcon,
  AlertTriangleIcon,
  UsersIcon,
  ActivityIcon,
  WifiIcon,
  WifiOffIcon,
} from "lucide-react";
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
            <span className="truncate text-xs text-muted-foreground">
              <UsersIcon className="mr-0.5 inline size-3" />
              {host.owner}
            </span>
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
 * 调度视图（admin）：列出所有用户的 host 舰队 + 在线统计 + 按用户分组。
 * 普通用户只看到自己的 host（服务端按 user_id 过滤）。
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

  const stats = useMemo(() => {
    const total = hosts.length;
    const online = hosts.filter((h) => h.status === "online").length;
    const offline = total - online;
    const owners = new Set(hosts.map((h) => h.owner ?? "local"));
    return { total, online, offline, ownerCount: owners.size };
  }, [hosts]);

  // Group by owner (admin fleet view), sorted by owner then name.
  const grouped = useMemo(() => {
    const map = new Map<string, HostWire[]>();
    for (const h of [...hosts].sort((a, b) => {
      const ao = a.owner ?? "local";
      const bo = b.owner ?? "local";
      if (ao !== bo) return ao.localeCompare(bo);
      return a.name.localeCompare(b.name);
    })) {
      const owner = h.owner ?? "local";
      map.set(owner, [...(map.get(owner) ?? []), h]);
    }
    return [...map.entries()];
  }, [hosts]);

  const showFleet = grouped.length > 1 || (grouped.length === 1 && grouped[0][0] !== "local");

  return (
    <section>
      <h1 className="text-2xl font-semibold">{L("Hosts")}</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        {L("Machines registered as hosts on this server and the harnesses they joined.")}
      </p>

      {/* 调度统计条 */}
      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Card className="flex items-center gap-3 p-3">
          <ServerIcon className="size-4 text-muted-foreground" />
          <div>
            <div className="text-lg font-semibold leading-none">{stats.total}</div>
            <div className="mt-1 text-xs text-muted-foreground">{L("Total hosts")}</div>
          </div>
        </Card>
        <Card className="flex items-center gap-3 p-3">
          <WifiIcon className="size-4 text-emerald-500" />
          <div>
            <div className="text-lg font-semibold leading-none">{stats.online}</div>
            <div className="mt-1 text-xs text-muted-foreground">{L("Online")}</div>
          </div>
        </Card>
        <Card className="flex items-center gap-3 p-3">
          <WifiOffIcon className="size-4 text-muted-foreground" />
          <div>
            <div className="text-lg font-semibold leading-none">{stats.offline}</div>
            <div className="mt-1 text-xs text-muted-foreground">{L("Offline")}</div>
          </div>
        </Card>
        <Card className="flex items-center gap-3 p-3">
          <UsersIcon className="size-4 text-muted-foreground" />
          <div>
            <div className="text-lg font-semibold leading-none">{stats.ownerCount}</div>
            <div className="mt-1 text-xs text-muted-foreground">{L("Owners")}</div>
          </div>
        </Card>
      </div>

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

      {!isLoading && !error && hosts.length === 0 && (
        <p className="mt-4 text-sm text-muted-foreground">{L("No hosts connected yet")}</p>
      )}

      {/* 按 owner 分组展示（调度视图） */}
      <div className="mt-4 space-y-4">
        {grouped.map(([owner, list]) => (
          <div key={owner}>
            <div className="mb-1.5 flex items-center gap-2">
              <UsersIcon className="size-3.5 text-muted-foreground" />
              <span className="text-sm font-medium">{owner}</span>
              <Badge variant="outline" className="text-xs">
                {list.filter((h) => h.status === "online").length}/{list.length}{" "}
                {L("online")}
              </Badge>
            </div>
            <div className="space-y-2">
              {list.map((h) => (
                <HostCard key={h.host_id} host={h} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
