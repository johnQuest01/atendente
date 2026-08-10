import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { CloseIcon, DownloadIcon } from '@/components/ui/Icons';
import { toast } from '@/store/appStore';

interface ImageLightboxProps {
  src: string;
  alt?: string;
  open: boolean;
  onClose: () => void;
}

function filenameFromUrl(url: string): string {
  try {
    const path = new URL(url, window.location.origin).pathname;
    const base = path.split('/').pop() || '';
    if (base && /\.[a-z0-9]{2,5}$/i.test(base)) return decodeURIComponent(base);
  } catch {
    /* ignore */
  }
  return `imagem-${Date.now()}.jpg`;
}

async function downloadImage(url: string): Promise<void> {
  const name = filenameFromUrl(url);
  try {
    const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(objectUrl);
  } catch {
    // CORS / rede: abre em nova aba para o usuário salvar manualmente.
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
}

/** Visualização em tela cheia + baixar imagem da conversa. */
export function ImageLightbox({ src, alt = 'Imagem', open, onClose }: ImageLightboxProps) {
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  async function handleDownload() {
    setBusy(true);
    try {
      await downloadImage(src);
      toast('Download iniciado.', 'success');
    } catch {
      toast('Não foi possível baixar. Tente abrir a imagem e salvar.', 'error');
    } finally {
      setBusy(false);
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex flex-col bg-black/95"
      role="dialog"
      aria-modal="true"
      aria-label="Visualizar imagem"
    >
      <header className="safe-top flex shrink-0 items-center justify-between gap-2 px-3 py-3">
        <button
          type="button"
          onClick={onClose}
          className="tap-scale flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white"
          aria-label="Fechar"
        >
          <CloseIcon width={22} height={22} />
        </button>
        <button
          type="button"
          onClick={() => void handleDownload()}
          disabled={busy}
          className="tap-scale flex items-center gap-2 rounded-full bg-white/15 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          <DownloadIcon width={18} height={18} />
          Baixar
        </button>
      </header>

      <div
        className="flex min-h-0 flex-1 items-center justify-center px-2 pb-6"
        onClick={onClose}
      >
        <img
          src={src}
          alt={alt}
          onClick={(e) => e.stopPropagation()}
          className="max-h-full max-w-full object-contain select-none"
          draggable={false}
        />
      </div>
    </div>,
    document.body,
  );
}
