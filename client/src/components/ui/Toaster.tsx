import { createPortal } from 'react-dom';
import { useAppStore, type ToastVariant } from '@/store/appStore';
import { cn } from '@/utils/cn';

const styles: Record<ToastVariant, string> = {
  success: 'bg-success text-white',
  error: 'bg-danger text-white',
  info: 'bg-text-primary text-white',
};

export function Toaster() {
  const { toasts, removeToast } = useAppStore();

  return createPortal(
    <div className="safe-top pointer-events-none fixed inset-x-0 top-0 z-[60] flex flex-col items-center gap-2 px-4 pt-3">
      {toasts.map((t) => (
        <button
          key={t.id}
          onClick={() => removeToast(t.id)}
          className={cn(
            'pointer-events-auto w-full max-w-sm animate-toast-in rounded-xl px-4 py-3 text-sm font-medium shadow-lg',
            styles[t.variant],
          )}
        >
          {t.message}
        </button>
      ))}
    </div>,
    document.body,
  );
}
