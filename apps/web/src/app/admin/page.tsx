'use client';

import { api, clearAuth, isAuthenticated } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Activity, FileText, Server, Ticket as TicketIcon, Users, AlertTriangle } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import useSWR from 'swr';

const fetcher = (url: string) => api(url).then((res) => res.json());

function StatCard({ title, value, icon: Icon }: { title: string; value: string | number; icon: any }) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">{value}</div>
      </CardContent>
    </Card>
  );
}

export default function AdminDashboard() {
  const router = useRouter();
  const { data } = useSWR('/api/admin/dashboard', fetcher);
  const [authed, setAuthed] = useState(false);

  useEffect(() => {
    if (!isAuthenticated()) {
      router.push('/');
    } else {
      setAuthed(true);
    }
  }, [router]);

  if (!authed) return null;

  const stats = data?.stats || {};

  return (
    <div className="flex min-h-screen">
      <aside className="w-64 border-r bg-card">
        <div className="flex h-16 items-center border-b px-6">
          <h1 className="text-lg font-semibold">IPTV Home Gateway</h1>
        </div>
        <nav className="space-y-1 p-4">
          <Link href="/admin" className="flex items-center gap-2 rounded-md bg-accent px-3 py-2 text-sm">
            <Activity className="h-4 w-4" />
            Tableau de bord
          </Link>
          <Link href="/admin/tickets" className="flex items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-accent">
            <TicketIcon className="h-4 w-4" />
            Tickets
          </Link>
          <Link href="/admin/providers" className="flex items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-accent">
            <Server className="h-4 w-4" />
            Fournisseurs
          </Link>
          <Link href="/admin/logs" className="flex items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-accent">
            <FileText className="h-4 w-4" />
            Journaux
          </Link>
          <Button
            variant="ghost"
            className="w-full justify-start gap-2"
            onClick={() => {
              clearAuth();
              router.push('/');
            }}
          >
            Déconnexion
          </Button>
        </nav>
      </aside>
      <main className="flex-1 p-8">
        <h2 className="mb-6 text-3xl font-bold">Tableau de bord</h2>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <StatCard title="Tickets actifs" value={stats.activeTickets || 0} icon={TicketIcon} />
          <StatCard title="Connexions en cours" value={stats.activeSessions || 0} icon={Users} />
          <StatCard title="Flux upstream" value={stats.hubFeeds || 0} icon={Activity} />
          <StatCard title="Clients uniques (24h)" value={stats.uniqueClients || 0} icon={AlertTriangle} />
        </div>
        <div className="mt-6 grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Fournisseurs</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {(data?.providers || []).map((p: any) => (
                  <div key={p.id} className="flex items-center justify-between rounded-md border p-3 text-sm">
                    <div>
                      <p className="font-medium">{p.name}</p>
                      <p className="text-muted-foreground">
                        {p.activeConnections} / {p.maxConnections} connexions ({p.usagePercent}%)
                      </p>
                    </div>
                    <span className="rounded-full border px-2 py-0.5 text-xs">{p.status}</span>
                  </div>
                ))}
                {(data?.providers || []).length === 0 && (
                  <p className="text-sm text-muted-foreground">Aucun fournisseur configure.</p>
                )}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Tickets bientot expires</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {(data?.expiringTickets || []).map((t: any) => (
                  <div key={t.id} className="flex items-center justify-between rounded-md border p-3 text-sm">
                    <div>
                      <p className="font-medium">{t.label}</p>
                      <p className="text-muted-foreground">{t.username}</p>
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {new Date(t.expiresAt).toLocaleString('fr-FR')}
                    </span>
                  </div>
                ))}
                {(data?.expiringTickets || []).length === 0 && (
                  <p className="text-sm text-muted-foreground">Aucun ticket en fin de validite.</p>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  );
}
