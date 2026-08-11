import { useEffect, useRef } from 'react';
import { useRefreshQr } from '@/hooks/useWhatsappOnboarding';

const QR_INTERVAL_MS = 18_000;
/** WhatsApp pede novo scan rápido — primeira renovação um pouco antes. */
const QR_FIRST_REFRESH_MS = 12_000;
const QR_MAX_AUTO = 20;

/**
 * Renova o QR sozinho enquanto o pareamento está pendente.
 * O WhatsApp invalida o QR ~20s e muitas vezes pede para escanear de novo.
 */
export function useAutoRefreshQr(opts: {
  connectionId: string | undefined;
  /** true enquanto aguarda leitura e há (ou deve haver) QR na tela */
  enabled: boolean;
  onQr: (qrBase64: string) => void;
}): { refreshing: boolean; attempts: number; exhausted: boolean } {
  const refreshQr = useRefreshQr(opts.connectionId);
  const onQrRef = useRef(opts.onQr);
  onQrRef.current = opts.onQr;
  const attemptsRef = useRef(0);
  const exhaustedRef = useRef(false);

  useEffect(() => {
    if (!opts.enabled || !opts.connectionId) return;

    attemptsRef.current = 0;
    exhaustedRef.current = false;
    let cancelled = false;

    const tick = () => {
      if (cancelled || exhaustedRef.current) return;
      if (attemptsRef.current >= QR_MAX_AUTO) {
        exhaustedRef.current = true;
        return;
      }
      void refreshQr
        .mutateAsync()
        .then((r) => {
          if (cancelled) return;
          attemptsRef.current += 1;
          if (r.qrBase64) onQrRef.current(r.qrBase64);
          if (attemptsRef.current >= QR_MAX_AUTO) exhaustedRef.current = true;
        })
        .catch(() => undefined);
    };

    const first = setTimeout(tick, QR_FIRST_REFRESH_MS);
    const interval = setInterval(tick, QR_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearTimeout(first);
      clearInterval(interval);
    };
    // refreshQr.mutateAsync é estável o bastante; reage a conexão/enabled
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.enabled, opts.connectionId]);

  return {
    refreshing: refreshQr.isPending,
    attempts: attemptsRef.current,
    exhausted: exhaustedRef.current,
  };
}
