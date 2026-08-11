import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Input, Select } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { Spinner, EmptyState } from '@/components/ui/States';
import { api, getErrorMessage } from '@/services/api';
import { toast } from '@/store/appStore';

interface PoolInstance {
  id: string;
  provider_mode: 'web' | 'phoneless';
  state: 'free' | 'in_use';
  assigned_tenant_id: string | null;
  label: string | null;
  created_at: string;
}

interface PoolResponse {
  instances: PoolInstance[];
  free: { web: number; phoneless: number };
  encryptionAvailable: boolean;
}

/**
 * Superadmin: abastece o pool de instâncias assinadas (trial 7 dias).
 * Tokens nunca são listados de volta — só id/estado/label.
 */
export function InstancePoolManager() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['admin-instance-pool'],
    queryFn: async () => {
      const { data: res } = await api.get<PoolResponse>('/admin/whatsapp/instance-pool');
      return res;
    },
  });

  const add = useMutation({
    mutationFn: async (body: {
      instanceId: string;
      token: string;
      clientToken?: string;
      providerMode: 'web' | 'phoneless';
      label?: string;
    }) => {
      const { data: res } = await api.post('/admin/whatsapp/instance-pool', body);
      return res;
    },
    onSuccess: () => {
      toast('Instância adicionada ao pool.', 'success');
      setOpen(false);
      void qc.invalidateQueries({ queryKey: ['admin-instance-pool'] });
    },
    onError: (err) => toast(getErrorMessage(err), 'error'),
  });

  const [instanceId, setInstanceId] = useState('');
  const [token, setToken] = useState('');
  const [clientToken, setClientToken] = useState('');
  const [providerMode, setProviderMode] = useState<'web' | 'phoneless'>('web');
  const [label, setLabel] = useState('');

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-bold text-text-primary">Pool WhatsApp (trial)</h2>
          <p className="text-sm text-text-secondary">
            Instâncias já assinadas na Z-API, recicladas nos trials de 7 dias.
          </p>
        </div>
        <Button size="sm" onClick={() => setOpen(true)}>
          Adicionar
        </Button>
      </div>

      {isLoading && <Spinner label="Carregando pool..." />}
      {isError && (
        <p className="text-sm text-danger">
          Não foi possível carregar.{' '}
          <button type="button" className="underline" onClick={() => void refetch()}>
            Tentar de novo
          </button>
        </p>
      )}

      {data && (
        <Card className="flex flex-col gap-2">
          <p className="text-xs text-text-secondary">
            Livres — web: {data.free.web} · phoneless: {data.free.phoneless}
            {!data.encryptionAvailable && ' · ENCRYPTION_KEY ausente'}
          </p>
          {data.instances.length === 0 ? (
            <EmptyState
              title="Pool vazio"
              description="Adicione ao menos 1 instância assinada para cobrir trials simultâneos."
            />
          ) : (
            <ul className="flex flex-col divide-y divide-border">
              {data.instances.map((row) => (
                <li key={row.id} className="flex items-center justify-between gap-2 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-text-primary">
                      {row.label || row.id.slice(0, 8)}
                    </p>
                    <p className="text-xs text-text-secondary">{row.provider_mode}</p>
                  </div>
                  <Badge tone={row.state === 'free' ? 'success' : 'warning'}>
                    {row.state === 'free' ? 'Livre' : 'Em uso'}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      <Modal open={open} onClose={() => setOpen(false)} title="Adicionar ao pool">
        <div className="flex flex-col gap-3">
          <p className="text-xs text-text-secondary">
            A instância precisa estar criada e assinada na Z-API. Os tokens ficam cifrados.
          </p>
          <Input
            label="Label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Trial pool #1"
          />
          <Input
            label="Instance ID"
            value={instanceId}
            onChange={(e) => setInstanceId(e.target.value)}
            autoComplete="off"
          />
          <Input
            label="Instance Token"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            type="password"
            autoComplete="off"
          />
          <Input
            label="Client-Token (opcional)"
            value={clientToken}
            onChange={(e) => setClientToken(e.target.value)}
            type="password"
            autoComplete="off"
          />
          <Select
            label="Modo"
            value={providerMode}
            onChange={(e) => setProviderMode(e.target.value as 'web' | 'phoneless')}
          >
            <option value="web">Web (aparelhos conectados)</option>
            <option value="phoneless">Phoneless</option>
          </Select>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancelar
            </Button>
            <Button
              loading={add.isPending}
              disabled={!instanceId.trim() || !token.trim()}
              onClick={() =>
                void add.mutateAsync({
                  instanceId: instanceId.trim(),
                  token: token.trim(),
                  clientToken: clientToken.trim() || undefined,
                  providerMode,
                  label: label.trim() || undefined,
                }).then(() => {
                  setInstanceId('');
                  setToken('');
                  setClientToken('');
                  setLabel('');
                })
              }
            >
              Salvar no pool
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
