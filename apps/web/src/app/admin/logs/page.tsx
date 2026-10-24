'use client';

import { api, clearAuth, isAuthenticated } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Activity, FileText, Server, Ticket as TicketIcon } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import useSWR from 'swr';

const fetcher = (url: string) => api(url).then((res) => res.json());

export default function LogsPage() {
  const router = useRouter();
  const { data } = useSWR('/api/admin/logs', fetcher);
  const [authed, setAuthed] = useState(false);

  useEffect(() => {
    if (!isAuthenticated()) router.push('/');
    else setAuthed(true);
  }, [router]);

  if (!authed) return null;

  const logs = data?.items || [];

  return (
    <div className="flex min-h-screen">
      <aside className="w-64 border-r bg-card">
        <div className="flex h-16 items-center border-b px-6">
          <h1 className="text-lg font-semibold">IPTV Home Gateway</h1>
        </div>
        <nav className="space-y-1 p-4">
          <Link href="/admin" className="flex items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-accent">
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
          <Link href="/admin/logs" className="flex items-center gap-2 rounded-md bg-accent px-3 py-2 text-sm">
            <FileText className="h-4 w-4" />
            Journaux
          </Link>
          <Button variant="ghost" className="w-full justify-start gap-2" onClick={() => { clearAuth(); router.push('/'); }}>
            Déconnexion
          </Button>
        </nav>
      </aside>
      <main className="flex-1 p-8">
        <h2 className="mb-6 text-3xl font-bold">Journaux</h2>
        <Card>
          <CardHeader>
            <CardTitle>Historique des actions</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="p-2 text-left">Date</th>
                    <th className="p-2 text-left">Action</th>
                    <th className="p-2 text-left">Détail</th>
                    <th className="p-2 text-left">IP</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.map((l: any) => (
                    <tr key={l.id} className="border-b">
                      <td className="p-2">{new Date(l.createdAt).toLocaleString('fr-FR')}</td>
                      <td className="p-2">{l.action}</td>
                      <td className="p-2">{l.detail || '-'}</td>
                      <td className="p-2">{l.ipAddress || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
