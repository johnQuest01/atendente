import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/hooks/useAuth';
import { SAFE_MODE_QUERY_KEY, useSafeModeStatus, useSetSafeMode } from '@/hooks/useSafeMode';
import { useSocket } from '@/hooks/useSocket';
import { toast } from '@/store/appStore';
import { getErrorMessage } from '@/services/api';

/**
 * Banner persistente quando SAFE_MODE está desligada + toasts de bloqueio via socket.
 */
export function SafeModeBanner() {
  const { user } = useAuth();
  const canEdit = user?.role === 'admin' || user?.role === 'superadmin';
  const qc = useQueryClient();
  const { data } = useSafeModeStatus();
  const setSafe = useSetSafeMode();
  const safeOn = data?.enabled ?? true;

  const onStatus = useCallback(
    (payload: unknown) => {
      const p = payload as { enabled?: boolean } | undefined;
      if (typeof p?.enabled !== 'boolean') return;
      qc.setQueryData(SAFE_MODE_QUERY_KEY, (old: { enabled: boolean; businessInitiatedEnabled: boolean } | undefined) => ({
        enabled: p.enabled!,
        businessInitiatedEnabled: old?.businessInitiatedEnabled ?? false,
      }));
    },
    [qc],
  );

  const onBlocked = useCallback((payload: unknown) => {
    const p = payload as { message?: string } | undefined;
    toast(p?.message ?? 'Modo inbound-only: não inicio conversa, só respondo quem me chama.', 'info');
  }, []);

  useSocket({
    'safe_mode:status': onStatus,
    'send:blocked': onBlocked,
  });

  if (safeOn) return null;

  return (
    <div className="shrink-0 border-b border-danger/40 bg-danger/10 px-4 py-2 text-center text-xs font-semibold text-danger">
      Modo seguro DESLIGADO — o sistema não impede envios proativos (risco de ban).
      {canEdit && (
        <button
          type="button"
          className="ml-2 underline"
          disabled={setSafe.isPending}
          onClick={() => {
            void setSafe
              .mutateAsync(true)
              .then(() => toast('Modo seguro ligado — só responde quem chama.', 'success'))
              .catch((err) => toast(getErrorMessage(err), 'error'));
          }}
        >
          Religar
        </button>
      )}
    </div>
  );
}
