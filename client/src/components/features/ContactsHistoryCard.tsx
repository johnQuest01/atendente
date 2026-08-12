import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { ConnectionNumberPicker } from '@/components/features/ConnectionNumberPicker';
import {
  useExportContactsJson,
  useExportContactsVcf,
  useImportContactsJson,
  useSyncWhatsappContacts,
} from '@/hooks/useContactsExport';
import { useWhatsappConnections } from '@/hooks/useWhatsappConnection';
import { toast } from '@/store/appStore';
import { getErrorMessage } from '@/services/api';

/** Exporta agenda (VCF), backup de conversas (JSON) e importa — sempre por número. */
export function ContactsHistoryCard({
  connectionId: fixedConnectionId,
}: {
  /** Se informado, fixa neste número e esconde o picker. */
  connectionId?: string;
} = {}) {
  const { data: wa } = useWhatsappConnections();
  const connections = (wa?.connections ?? []).filter((c) => c.isActive !== false);
  const [pickedId, setPickedId] = useState('');
  const connectionId = fixedConnectionId || pickedId;

  useEffect(() => {
    if (fixedConnectionId) return;
    if (!pickedId && connections.length === 1) {
      setPickedId(connections[0].id);
    }
  }, [connections, pickedId, fixedConnectionId]);

  const exportVcf = useExportContactsVcf();
  const exportJson = useExportContactsJson();
  const importJson = useImportContactsJson();
  const syncWa = useSyncWhatsappContacts();
  const fileRef = useRef<HTMLInputElement>(null);

  function requireConnection(): string | null {
    if (!connectionId) {
      toast('Escolha de qual número WhatsApp é esta operação.', 'error');
      return null;
    }
    return connectionId;
  }

  async function handleVcf() {
    const id = requireConnection();
    if (!id) return;
    try {
      const meta = await exportVcf.mutateAsync(id);
      const n = meta.count ?? 0;
      const skip = meta.skipped ?? 0;
      toast(
        n === 0
          ? 'Nenhum número válido (55+DDD) neste WhatsApp.'
          : `${n} contato(s) deste número${skip ? ` · ${skip} ignorado(s)` : ''}.`,
        n === 0 ? 'error' : 'success',
      );
    } catch (err) {
      toast(getErrorMessage(err, 'Falha ao baixar agenda.'), 'error');
    }
  }

  async function handleJson() {
    const id = requireConnection();
    if (!id) return;
    try {
      await exportJson.mutateAsync(id);
      toast('Backup deste WhatsApp baixado.', 'success');
    } catch (err) {
      toast(getErrorMessage(err, 'Falha ao baixar conversas.'), 'error');
    }
  }

  async function handleImport(file: File | null) {
    if (!file) return;
    const id = requireConnection();
    if (!id) return;
    try {
      const result = await importJson.mutateAsync({ file, connectionId: id });
      toast(result.detail, 'success');
    } catch (err) {
      toast(getErrorMessage(err, 'Falha ao importar arquivo.'), 'error');
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function handleSyncWhatsapp() {
    const id = requireConnection();
    if (!id) return;
    try {
      const result = await syncWa.mutateAsync(id);
      toast(result.detail, result.fetched === 0 ? 'error' : 'success');
    } catch (err) {
      toast(getErrorMessage(err, 'Falha ao sincronizar agenda do WhatsApp.'), 'error');
    }
  }

  return (
    <Card className="flex flex-col gap-3">
      <div>
        <h2 className="text-base font-bold text-text-primary">Contatos e histórico</h2>
        <p className="mt-1 text-sm text-text-secondary">
          Sincronize a agenda do celular para a IA achar nomes (ex.: Wender). Backup e importação
          também são por número WhatsApp.
        </p>
      </div>

      {!fixedConnectionId && (
        <ConnectionNumberPicker
          value={pickedId}
          onChange={setPickedId}
          label="De qual número?"
          cards={connections.length > 1}
        />
      )}

      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        <Button
          type="button"
          variant="primary"
          loading={syncWa.isPending}
          disabled={!connectionId}
          onClick={() => void handleSyncWhatsapp()}
        >
          Sincronizar agenda do WhatsApp
        </Button>
        <Button
          type="button"
          variant="secondary"
          loading={exportVcf.isPending}
          disabled={!connectionId}
          onClick={() => void handleVcf()}
        >
          Baixar agenda (VCF)
        </Button>
        <Button
          type="button"
          variant="secondary"
          loading={exportJson.isPending}
          disabled={!connectionId}
          onClick={() => void handleJson()}
        >
          Baixar conversas (JSON)
        </Button>
        <Button
          type="button"
          variant="ghost"
          loading={importJson.isPending}
          disabled={!connectionId}
          onClick={() => fileRef.current?.click()}
        >
          Importar JSON
        </Button>
        <Link
          to={connectionId ? `/colar-conversa?connectionId=${connectionId}` : '/colar-conversa'}
          className="tap-scale inline-flex h-11 items-center justify-center rounded-xl bg-primary-gradient px-4 text-[15px] font-semibold text-white shadow-glow"
        >
          Colar conversa
        </Link>
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={(e) => void handleImport(e.target.files?.[0] ?? null)}
      />

      <p className="text-xs text-text-secondary">
        Sync: nomes salvos no celular entram no CRM para o secretário enviar mensagens por nome.
        VCF/JSON e colar gravam só neste número.
      </p>
    </Card>
  );
}
