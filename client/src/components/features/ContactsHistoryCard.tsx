import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { ConnectionNumberPicker } from '@/components/features/ConnectionNumberPicker';
import {
  useExportContactsJson,
  useExportContactsVcf,
  useImportContactsJson,
} from '@/hooks/useContactsExport';
import { useWhatsappConnections } from '@/hooks/useWhatsappConnection';
import { toast } from '@/store/appStore';
import { getErrorMessage } from '@/services/api';

/** Exporta agenda (VCF), backup de conversas (JSON) e importa — sempre por número. */
export function ContactsHistoryCard() {
  const { data: wa } = useWhatsappConnections();
  const connections = (wa?.connections ?? []).filter((c) => c.isActive !== false);
  const [connectionId, setConnectionId] = useState('');

  useEffect(() => {
    if (!connectionId && connections.length === 1) {
      setConnectionId(connections[0].id);
    }
  }, [connections, connectionId]);

  const exportVcf = useExportContactsVcf();
  const exportJson = useExportContactsJson();
  const importJson = useImportContactsJson();
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

  return (
    <Card className="flex flex-col gap-3">
      <div>
        <h2 className="text-base font-bold text-text-primary">Contatos e histórico</h2>
        <p className="mt-1 text-sm text-text-secondary">
          Tudo é por número WhatsApp: agenda, backup e importação não misturam instâncias nem
          contas.
        </p>
      </div>

      <ConnectionNumberPicker
        value={connectionId}
        onChange={setConnectionId}
        label="De qual número?"
        cards={connections.length > 1}
      />

      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
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
        VCF: telefone <span className="font-mono">5511915287476</span>. JSON e colar gravam só na
        conversa deste número no banco.
      </p>
    </Card>
  );
}
