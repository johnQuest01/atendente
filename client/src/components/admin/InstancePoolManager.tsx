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
  envInstanceConfigured?: boolean;
}

/**
 * Você (ops) cadastra instâncias Z-API já pagas e SEM número.
 * O cliente só digita o telefone no app — nunca abre a Z-API.
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
      toast('Instância pronta no pool — clientes já podem conectar.', 'success');
      setOpen(false);
      void qc.invalidateQueries({ queryKey: ['admin-instance-pool'] });
    },
    onError: (err) => toast(getErrorMessage(err), 'error'),
  });

  const importEnv = useMutation({
    mutationFn: async () => {
      const { data: res } = await api.post('/admin/whatsapp/instance-pool/import-env');
      return res;
    },
    onSuccess: () => {
      toast('Instância do servidor adicionada ao pool.', 'success');
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
          <h2 className="text-base font-bold text-text-primary">Instâncias prontas (pool)</h2>
          <p className="text-sm text-text-secondary">
            Cadastre aqui instâncias <strong>já pagas na Z-API e sem número</strong>. O cliente só
            digita o telefone e recebe o código — sem abrir o painel da Z-API.
          </p>
        </div>
        <Button size="sm" onClick={() => setOpen(true)}>
          Adicionar
        </Button>
      </div>

      {data?.envInstanceConfigured && (
        <Card className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-text-secondary">
            Há uma instância nos secrets do servidor (ZAPI_INSTANCE_ID). Só importe se ela estiver{' '}
            <strong>paga e sem número conectado</strong>.
          </p>
          <Button
            size="sm"
            variant="secondary"
            loading={importEnv.isPending}
            onClick={() => void importEnv.mutateAsync()}
          >
            Usar instância do servidor
          </Button>
        </Card>
      )}

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
            Livres: {data.free.web + data.free.phoneless} · Em uso:{' '}
            {data.instances.filter((i) => i.state === 'in_use').length}
            {!data.encryptionAvailable && ' · ENCRYPTION_KEY ausente'}
          </p>
          {data.instances.length === 0 ? (
            <EmptyState
              title="Nenhuma instância no pool"
              description="No painel Z-API, copie ID + Token de uma instância paga sem número e adicione aqui."
              action={
                <Button size="sm" onClick={() => setOpen(true)}>
                  Adicionar instância
                </Button>
              }
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
                    {row.state === 'free' ? 'Livre (pronta)' : 'Em uso'}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      <Modal open={open} onClose={() => setOpen(false)} title="Adicionar instância paga">
        <div className="flex flex-col gap-3">
          <p className="text-xs text-text-secondary">
            Na Z-API: instância assinada, <strong>sem WhatsApp conectado</strong>. Cole os dados
            aqui uma vez — o cliente nunca vê isso.
          </p>
          <Input
            label="Apelido (opcional)"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Ex.: Reserva 1"
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
                void add
                  .mutateAsync({
                    instanceId: instanceId.trim(),
                    token: token.trim(),
                    clientToken: clientToken.trim() || undefined,
                    providerMode,
                    label: label.trim() || undefined,
                  })
                  .then(() => {
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
