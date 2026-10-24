'use client';

import { api, clearAuth, isAuthenticated } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Activity, FileText, Plus, RefreshCw, Server, Ticket as TicketIcon } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import useSWR from 'swr';

const fetcher = (url: string) => api(url).then((res) => res.json());

export default function ProvidersPage() {
  const router = useRouter();
  const { data, mutate } = useSWR('/api/admin/providers', fetcher);
  const [authed, setAuthed] = useState(false);
  const [form, setForm] = useState({
    name: '',
    kind: 'XTREAM',
    baseUrl: '',
    playlistUrl: '',
    username: '',
    password: '',
    maxConnections: 1,
    overflowPolicy: 'REJECT',
  });

  useEffect(() => {
    if (!isAuthenticated()) router.push('/');
    else setAuthed(true);
  }, [router]);

  if (!authed) return null;

  const createProvider = async (e: React.FormEvent) => {
    e.preventDefault();
    await api('/api/admin/providers', {
      method: 'POST',
      body: JSON.stringify({ ...form, maxConnections: Number(form.maxConnections) }),
    });
    mutate();
  };

  const syncProvider = async (id: string) => {
    await api(`/api/admin/providers/${id}/sync`, { method: 'POST' });
    mutate();
  };

  const providers = data?.items || [];

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
          <Link href="/admin/providers" className="flex items-center gap-2 rounded-md bg-accent px-3 py-2 text-sm">
            <Server className="h-4 w-4" />
            Fournisseurs
          </Link>
          <Link href="/admin/logs" className="flex items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-accent">
            <FileText className="h-4 w-4" />
            Journaux
          </Link>
          <Button variant="ghost" className="w-full justify-start gap-2" onClick={() => { clearAuth(); router.push('/'); }}>
            Déconnexion
          </Button>
        </nav>
      </aside>
      <main className="flex-1 p-8">
        <h2 className="mb-6 text-3xl font-bold">Fournisseurs</h2>
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Ajouter un fournisseur</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={createProvider} className="grid gap-4 md:grid-cols-3">
              <div className="space-y-2">
                <Label>Nom</Label>
                <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
              </div>
              <div className="space-y-2">
                <Label>Type</Label>
                <select className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
                  <option value="XTREAM">Xtream Codes</option>
                  <option value="M3U">Playlist M3U</option>
                </select>
              </div>
              <div className="space-y-2">
                <Label>URL</Label>
                <Input value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} required />
              </div>
              {form.kind === 'XTREAM' ? (
                <>
                  <div className="space-y-2">
                    <Label>Identifiant</Label>
                    <Input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
                  </div>
                  <div className="space-y-2">
                    <Label>Mot de passe</Label>
                    <Input value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
                  </div>
                </>
              ) : (
                <div className="space-y-2 md:col-span-2">
                  <Label>URL de la playlist M3U</Label>
                  <Input
                    value={form.playlistUrl}
                    onChange={(e) => setForm({ ...form, playlistUrl: e.target.value })}
                    placeholder="http://serveur/playlist.m3u"
                  />
                </div>
              )}
              <div className="space-y-2">
                <Label>Connexions max</Label>
                <Input type="number" min={1} value={form.maxConnections} onChange={(e) => setForm({ ...form, maxConnections: Number(e.target.value) })} />
              </div>
              <Button type="submit" className="md:col-start-3">
                <Plus className="mr-2 h-4 w-4" />
                Ajouter
              </Button>
            </form>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Fournisseurs configurés</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="p-2 text-left">Nom</th>
                    <th className="p-2 text-left">Type</th>
                    <th className="p-2 text-left">URL</th>
                    <th className="p-2 text-left">Connexions max</th>
                    <th className="p-2 text-left">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {providers.map((p: any) => (
                    <tr key={p.id} className="border-b">
                      <td className="p-2">{p.name}</td>
                      <td className="p-2">{p.kind}</td>
                      <td className="p-2">{p.baseUrl}</td>
                      <td className="p-2">{p.maxConnections}</td>
                      <td className="p-2">
                        <Button variant="outline" size="sm" onClick={() => syncProvider(p.id)}>
                          <RefreshCw className="mr-2 h-4 w-4" />
                          Synchroniser
                        </Button>
                      </td>
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
