import { useEffect, useRef, useState } from 'react';
import { useRefreshQr } from '@/hooks/useWhatsappOnboarding';

/** Intervalo silencioso para buscar QR novo na Z-API (WhatsApp invalida o anterior). */
const POLL_MS = 15_000;

/**
 * Busca QR em background e só notifica a UI quando o conteúdo mudou.
 * A tela não “recarrega”: só a imagem do QR é trocada se vier um QR diferente.
 */
export function useAutoRefreshQr(opts: {
  connectionId: string | undefined;
  enabled: boolean;
  currentQr: string | null;
  onQr: (qrBase64: string) => void;
}): { checking: boolean } {
  const refreshQr = useRefreshQr(opts.connectionId);
  const onQrRef = useRef(opts.onQr);
  const currentQrRef = useRef(opts.currentQr);
  onQrRef.current = opts.onQr;
  currentQrRef.current = opts.currentQr;
  const [checking, setChecking] = useState(false);
  const inFlight = useRef(false);

  useEffect(() => {
    if (!opts.enabled || !opts.connectionId) return;

    let cancelled = false;

    const poll = () => {
      if (cancelled || inFlight.current) return;
      inFlight.current = true;
      setChecking(true);
      void refreshQr
        .mutateAsync()
        .then((r) => {
          if (cancelled) return;
          const next = r.qrBase64;
          if (next && next !== currentQrRef.current) {
            onQrRef.current(next);
          }
        })
        .catch(() => undefined)
        .finally(() => {
          inFlight.current = false;
          if (!cancelled) setChecking(false);
        });
    };

    // Primeira checagem após o QR atual “envelhecer” um pouco.
    const first = setTimeout(poll, POLL_MS);
    const interval = setInterval(poll, POLL_MS);

    return () => {
      cancelled = true;
      clearTimeout(first);
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.enabled, opts.connectionId]);

  return { checking };
}
