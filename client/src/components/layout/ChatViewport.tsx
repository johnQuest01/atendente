import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * Chat em portal: header + digitação fixos; só [data-chat-scroll] rola.
 * No mobile, acompanha a visualViewport para o teclado não empurrar a tela toda.
 */
export function ChatViewport({
  children,
  label = 'Conversa',
}: {
  children: ReactNode;
  label?: string;
}) {
  const shellRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const html = document.documentElement;
    const scrollY = window.scrollY;
    html.classList.add('chat-lock');
    document.body.dataset.chatOpen = '1';

    const shell = shellRef.current;

    function pinToVisualViewport() {
      const vv = window.visualViewport;
      if (!shell) return;

      // Cancela qualquer scroll que o teclado/foco tenha causado no documento.
      window.scrollTo(0, 0);
      html.scrollTop = 0;
      document.body.scrollTop = 0;

      if (!vv) {
        shell.style.top = '0px';
        shell.style.height = '100dvh';
        shell.style.transform = '';
        return;
      }

      // Shell = área visível (acima do teclado). Header e composer ficam no lugar;
      // só a lista de mensagens encolhe.
      shell.style.top = `${vv.offsetTop}px`;
      shell.style.height = `${vv.height}px`;
      shell.style.bottom = 'auto';
      shell.style.transform = '';
    }

    function onTouchMove(e: TouchEvent) {
      const el = e.target as HTMLElement | null;
      if (el?.closest?.('[data-chat-scroll="1"]')) return;
      if (el?.closest?.('textarea, input, [contenteditable="true"]')) return;
      if (el?.closest?.('[data-bottom-nav="1"]')) return;
      e.preventDefault();
    }

    function onScroll() {
      if (window.scrollY !== 0 || html.scrollTop !== 0) {
        window.scrollTo(0, 0);
        html.scrollTop = 0;
        document.body.scrollTop = 0;
      }
    }

    function onFocusIn(e: FocusEvent) {
      const t = e.target as HTMLElement | null;
      if (!t || !shell?.contains(t)) return;
      if (t.tagName !== 'TEXTAREA' && t.tagName !== 'INPUT') return;
      // iOS/Android tentam scrollar o input para o centro — re-pin após o teclado.
      requestAnimationFrame(pinToVisualViewport);
      setTimeout(pinToVisualViewport, 50);
      setTimeout(pinToVisualViewport, 250);
      setTimeout(pinToVisualViewport, 450);
    }

    pinToVisualViewport();

    const vv = window.visualViewport;
    vv?.addEventListener('resize', pinToVisualViewport);
    vv?.addEventListener('scroll', pinToVisualViewport);
    window.addEventListener('resize', pinToVisualViewport);
    window.addEventListener('scroll', onScroll, { passive: true });
    document.addEventListener('touchmove', onTouchMove, { passive: false });
    document.addEventListener('focusin', onFocusIn);

    return () => {
      vv?.removeEventListener('resize', pinToVisualViewport);
      vv?.removeEventListener('scroll', pinToVisualViewport);
      window.removeEventListener('resize', pinToVisualViewport);
      window.removeEventListener('scroll', onScroll);
      document.removeEventListener('touchmove', onTouchMove);
      document.removeEventListener('focusin', onFocusIn);
      if (shell) {
        shell.style.top = '';
        shell.style.height = '';
        shell.style.bottom = '';
        shell.style.transform = '';
      }
      html.classList.remove('chat-lock');
      delete document.body.dataset.chatOpen;
      window.scrollTo(0, scrollY);
    };
  }, []);

  return createPortal(
    <div
      ref={shellRef}
      className="chat-shell"
      role="dialog"
      aria-modal="true"
      aria-label={label}
    >
      <div className="mx-auto flex h-full min-h-0 w-full max-w-3xl flex-col overflow-hidden">
        {children}
      </div>
    </div>,
    document.body,
  );
}
