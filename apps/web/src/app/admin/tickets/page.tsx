'use client';

import { api, clearAuth, isAuthenticated } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Activity, FileText, Plus, Server, Ticket as TicketIcon } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import useSWR from 'swr';

const fetcher = (url: string) => api(url).then((res) => res.json());

export default function TicketsPage() {
  const router = useRouter();
  const { data, mutate } = useSWR('/api/admin/tickets', fetcher);
  const { data: providerData } = useSWR('/api/admin/providers', fetcher);
  const [authed, setAuthed] = useState(false);
  const [form, setForm] = useState({
    label: '',
    providerId: '',
    username: '',
    password: '',
    duration: 'D7',
    maxConnections: 1,
    overflowPolicy: 'REJECT',
  });

  useEffect(() => {
    if (!isAuthenticated()) router.push('/');
    else setAuthed(true);
  }, [router]);

  if (!authed) return null;

  const createTicket = async (e: React.FormEvent) => {
    e.preventDefault();
    const res = await api('/api/admin/tickets', {
      method: 'POST',
      body: JSON.stringify({ ...form, maxConnections: Number(form.maxConnections) }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(body?.message ?? 'Creation impossible');
    }
    mutate();
    setForm({ ...form, label: '', username: '', password: '' });
  };

  const tickets = data?.items || [];
  const providers = providerData?.items || [];

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
          <Link href="/admin/tickets" className="flex items-center gap-2 rounded-md bg-accent px-3 py-2 text-sm">
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
          <Button variant="ghost" className="w-full justify-start gap-2" onClick={() => { clearAuth(); router.push('/'); }}>
            Déconnexion
          </Button>
        </nav>
      </aside>
      <main className="flex-1 p-8">
        <h2 className="mb-6 text-3xl font-bold">Tickets</h2>
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Créer un ticket</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={createTicket} className="grid gap-4 md:grid-cols-3">
              <div className="space-y-2">
                <Label>Libellé</Label>
                <Input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} required />
              </div>
              <div className="space-y-2">
                <Label>Fournisseur</Label>
                <select className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={form.providerId} onChange={(e) => setForm({ ...form, providerId: e.target.value })} required>
                  <option value="">Selectionner...</option>
                  {providers.map((p: any) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-2">
                <Label>Identifiant</Label>
                <Input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
              </div>
              <div className="space-y-2">
                <Label>Mot de passe</Label>
                <Input value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
              </div>
              <div className="space-y-2">
                <Label>Durée</Label>
                <select className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={form.duration} onChange={(e) => setForm({ ...form, duration: e.target.value })}>
                  <option value="H24">24 heures</option>
                  <option value="D7">7 jours</option>
                  <option value="D30">30 jours</option>
                </select>
              </div>
              <div className="space-y-2">
                <Label>Connexions max</Label>
                <Input type="number" min={1} value={form.maxConnections} onChange={(e) => setForm({ ...form, maxConnections: Number(e.target.value) })} />
              </div>
              <div className="space-y-2">
                <Label>Politique de débordement</Label>
                <select className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={form.overflowPolicy} onChange={(e) => setForm({ ...form, overflowPolicy: e.target.value })}>
                  <option value="REJECT">Refuser</option>
                  <option value="EVICT_OLDEST">Déconnecter le plus ancien</option>
                </select>
              </div>
              <Button type="submit" className="md:col-start-3">
                <Plus className="mr-2 h-4 w-4" />
                Créer
              </Button>
            </form>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Liste des tickets</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="p-2 text-left">Libellé</th>
                    <th className="p-2 text-left">Identifiant</th>
                    <th className="p-2 text-left">Statut</th>
                    <th className="p-2 text-left">Expire le</th>
                    <th className="p-2 text-left">Connexions</th>
                  </tr>
                </thead>
                <tbody>
                  {tickets.map((t: any) => (
                    <tr key={t.id} className="border-b">
                      <td className="p-2">{t.label}</td>
                      <td className="p-2">{t.username}</td>
                      <td className="p-2">{t.status}</td>
                      <td className="p-2">{t.expiresAt ? new Date(t.expiresAt).toLocaleString('fr-FR') : '-'}</td>
                      <td className="p-2">{t.maxConnections}</td>
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
