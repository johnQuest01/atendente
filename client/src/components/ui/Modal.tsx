import { type ReactNode, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/utils/cn';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  footer?: ReactNode;
}

export function Modal({ open, onClose, title, children, footer }: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <div className="absolute inset-0 animate-fade-in bg-black/40" onClick={onClose} />
      <div
        className={cn(
          'relative z-10 flex max-h-[90vh] w-full flex-col rounded-t-3xl bg-surface shadow-xl',
          'animate-slide-in sm:max-w-md sm:rounded-3xl',
        )}
        role="dialog"
        aria-modal="true"
      >
        {title && (
          <header className="flex items-center justify-between border-b border-border px-5 py-4">
            <h2 className="text-lg font-bold text-text-primary">{title}</h2>
            <button
              onClick={onClose}
              className="tap-scale -mr-1 rounded-full p-1 text-text-secondary hover:bg-black/5"
              aria-label="Fechar"
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 6 6 18M6 6l12 12" strokeLinecap="round" />
              </svg>
            </button>
          </header>
        )}
        <div className="no-scrollbar flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && (
          <footer className="safe-bottom border-t border-border px-5 py-3">{footer}</footer>
        )}
      </div>
    </div>,
    document.body,
  );
}
