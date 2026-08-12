import { useMutation } from '@tanstack/react-query';
import { api, getToken } from '@/services/api';

const apiBase = `${import.meta.env.VITE_API_URL ?? ''}/api`;

async function downloadAuthBlob(
  path: string,
  fallbackName: string,
): Promise<{ count?: number; skipped?: number }> {
  const token = getToken();
  const res = await fetch(`${apiBase}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    let message = `Falha ao baixar (${res.status})`;
    try {
      const j = (await res.json()) as { error?: string; message?: string };
      message = j.error || j.message || message;
    } catch {
      const text = await res.text().catch(() => '');
      if (text) message = text;
    }
    throw new Error(message);
  }
  const blob = await res.blob();
  const cd = res.headers.get('Content-Disposition') ?? '';
  const match = /filename="?([^"]+)"?/i.exec(cd);
  const filename = match?.[1] ?? fallbackName;
  const countHeader = res.headers.get('X-Contacts-Count');
  const skippedHeader = res.headers.get('X-Contacts-Skipped');
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return {
    count: countHeader != null ? Number(countHeader) : undefined,
    skipped: skippedHeader != null ? Number(skippedHeader) : undefined,
  };
}

export function useExportContactsVcf() {
  return useMutation({
    mutationFn: (connectionId: string) =>
      downloadAuthBlob(
        `/contacts/export.vcf?connectionId=${encodeURIComponent(connectionId)}`,
        'contatos-whatsapp.vcf',
      ),
  });
}

export function useExportContactsJson() {
  return useMutation({
    mutationFn: (connectionId: string) =>
      downloadAuthBlob(
        `/contacts/export.json?connectionId=${encodeURIComponent(connectionId)}`,
        'conversas-backup.json',
      ),
  });
}

export function useImportContactsJson() {
  return useMutation({
    mutationFn: async (input: { file: File; connectionId: string }) => {
      const text = await input.file.text();
      let backup: unknown;
      try {
        backup = JSON.parse(text);
      } catch {
        throw new Error('Arquivo não é um JSON válido.');
      }
      const { data } = await api.post<{
        ok: boolean;
        contacts: number;
        messagesInserted: number;
        messagesSkipped: number;
        detail: string;
      }>('/contacts/import', { connectionId: input.connectionId, backup });
      return data;
    },
  });
}

export function usePasteImport() {
  return useMutation({
    mutationFn: async (input: {
      connectionId: string;
      phone: string;
      name?: string | null;
      messages: Array<{ direction: 'inbound' | 'outbound'; text: string }>;
    }) => {
      const { data } = await api.post<{
        ok: boolean;
        conversationId: string;
        inserted: number;
        skipped: number;
        detail: string;
      }>('/contacts/paste-import', input);
      return data;
    },
  });
}

/** Puxa a agenda do WhatsApp (Z-API) para o CRM — nomes para a IA. */
export function useSyncWhatsappContacts() {
  return useMutation({
    mutationFn: async (connectionId: string) => {
      const { data } = await api.post<{
        ok: boolean;
        fetched: number;
        created: number;
        updated: number;
        skipped: number;
        detail: string;
      }>(`/contacts/sync-whatsapp?connectionId=${encodeURIComponent(connectionId)}`);
      return data;
    },
  });
}
