import { useCallback, useEffect, useRef, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Toggle } from '@/components/ui/Toggle';
import { LockIcon, TrashIcon } from '@/components/ui/Icons';
import {
  useAddBlocked,
  useBlockedNumbers,
  useDeleteBlocked,
  useSetBlockedActive,
  useUnlockBlocked,
} from '@/hooks/useBlocked';
import { useBlockAccess, clearBlockToken, toast } from '@/store/appStore';
import { getErrorMessage } from '@/services/api';
import { formatPhone } from '@/utils/formatters';
import { cn } from '@/utils/cn';

/** Formulário de login do cadeado (área restrita de números bloqueados). */
export function BlockUnlockModal({
  open,
  onClose,
  onUnlocked,
}: {
  open: boolean;
  onClose: () => void;
  onUnlocked?: () => void;
}) {
  const unlock = useUnlockBlocked();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  async function handleUnlock() {
    try {
      await unlock.mutateAsync({ email: email.trim(), password });
      setEmail('');
      setPassword('');
      toast('Acesso liberado.', 'success');
      onUnlocked?.();
    } catch (err) {
      toast(getErrorMessage(err, 'Login ou senha incorretos.'), 'error');
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Área restrita">
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2 text-text-secondary">
          <LockIcon width={18} height={18} />
          <p className="text-sm">Faça login para acessar os números bloqueados.</p>
        </div>
        <Input
          label="Login"
          type="email"
          autoComplete="off"
          placeholder="seu@email.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <Input
          label="Senha"
          type="password"
          autoComplete="off"
          placeholder="••••••••"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void handleUnlock();
            }
          }}
        />
        <Button fullWidth loading={unlock.isPending} disabled={!email.trim() || !password} onClick={handleUnlock}>
          Entrar
        </Button>
      </div>
    </Modal>
  );
}

/** Lista/gerência dos números bloqueados (só renderiza quando desbloqueado). */
function BlockedNumbersManager() {
  const { data: blocked } = useBlockedNumbers();
  const add = useAddBlocked();
  const setActive = useSetBlockedActive();
  const remove = useDeleteBlocked();
  const [phone, setPhone] = useState('');

  async function handleAdd() {
    const value = phone.trim();
    if (!value) return;
    try {
      await add.mutateAsync({ phone: value });
      setPhone('');
      toast('Número adicionado à lista de bloqueio.', 'success');
    } catch (err) {
      toast(getErrorMessage(err, 'Falha ao adicionar número.'), 'error');
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-text-secondary">
        Mensagens de números com o bloqueio ligado são ignoradas: não aparecem no painel e a IA não
        responde. Use a alavanca para ligar/desligar sem apagar.
      </p>

      <div className="flex items-end gap-2">
        <div className="flex-1">
          <Input
            label="Adicionar número (com DDD)"
            placeholder="Ex.: 11 99999-8888"
            inputMode="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void handleAdd();
              }
            }}
          />
        </div>
        <Button onClick={handleAdd} loading={add.isPending} disabled={!phone.trim()}>
          Adicionar
        </Button>
      </div>

      <ul className="flex max-h-72 flex-col divide-y divide-border overflow-y-auto">
        {(blocked ?? []).map((b) => (
          <li key={b.id} className="flex items-center justify-between gap-3 py-2.5">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-text-primary">{formatPhone(b.phone)}</p>
              <p className="truncate text-xs text-text-secondary">
                {b.label ? `${b.label} · ` : ''}
                {b.is_active ? 'Bloqueado' : 'Bloqueio desligado'}
              </p>
            </div>
            <Toggle
              checked={b.is_active}
              disabled={setActive.isPending}
              onChange={(next) => setActive.mutate({ id: b.id, is_active: next })}
              label="Ligar ou desligar o bloqueio deste número"
            />
            <button
              onClick={() => remove.mutate(b.id)}
              className="tap-scale rounded-full p-2 text-danger"
              aria-label="Remover número"
            >
              <TrashIcon width={18} height={18} />
            </button>
          </li>
        ))}
        {(blocked ?? []).length === 0 && (
          <li className="py-4 text-center text-sm text-text-secondary">Nenhum número bloqueado.</li>
        )}
      </ul>
    </div>
  );
}

const FAB_SIZE = 52;
const FAB_POS_KEY = 'mayra.fabPos';
const DRAG_THRESHOLD = 6;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function loadFabPos(): { x: number; y: number } {
  const margin = 16;
  const fallback = {
    x: window.innerWidth - FAB_SIZE - margin,
    y: window.innerHeight - FAB_SIZE - 96,
  };
  try {
    const raw = localStorage.getItem(FAB_POS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { x: number; y: number };
      return {
        x: clamp(parsed.x, margin, window.innerWidth - FAB_SIZE - margin),
        y: clamp(parsed.y, margin, window.innerHeight - FAB_SIZE - margin),
      };
    }
  } catch {
    /* usa o fallback */
  }
  return fallback;
}

/**
 * Botão flutuante de cadeado, arrastável (segurar e soltar em qualquer lugar)
 * e presente em todas as telas. Um toque simples abre a área restrita.
 */
function DraggableLockButton({ onTap }: { onTap: () => void }) {
  const [pos, setPos] = useState<{ x: number; y: number }>(() => loadFabPos());
  const [dragging, setDragging] = useState(false);
  const offsetRef = useRef({ x: 0, y: 0 });
  const startRef = useRef({ x: 0, y: 0 });
  const draggingRef = useRef(false);
  const movedRef = useRef(false);

  // Mantém o botão dentro da tela quando a janela é redimensionada/rotacionada.
  useEffect(() => {
    function onResize() {
      setPos((p) => ({
        x: clamp(p.x, 16, window.innerWidth - FAB_SIZE - 16),
        y: clamp(p.y, 16, window.innerHeight - FAB_SIZE - 16),
      }));
    }
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    movedRef.current = false;
    draggingRef.current = true;
    startRef.current = { x: e.clientX, y: e.clientY };
    setPos((p) => {
      offsetRef.current = { x: e.clientX - p.x, y: e.clientY - p.y };
      return p;
    });
    setDragging(true);
  }, []);

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    if (!draggingRef.current) return;
    if (
      Math.abs(e.clientX - startRef.current.x) > DRAG_THRESHOLD ||
      Math.abs(e.clientY - startRef.current.y) > DRAG_THRESHOLD
    ) {
      movedRef.current = true;
    }
    const nextX = clamp(e.clientX - offsetRef.current.x, 8, window.innerWidth - FAB_SIZE - 8);
    const nextY = clamp(e.clientY - offsetRef.current.y, 8, window.innerHeight - FAB_SIZE - 8);
    setPos({ x: nextX, y: nextY });
  }, []);

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      setDragging(false);
      try {
        (e.target as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      if (movedRef.current) {
        setPos((p) => {
          localStorage.setItem(FAB_POS_KEY, JSON.stringify(p));
          return p;
        });
      } else {
        onTap();
      }
    },
    [onTap],
  );

  return (
    <button
      aria-label="Números bloqueados (área restrita). Segure para mover."
      title="Números bloqueados"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onContextMenu={(e) => e.preventDefault()}
      style={{
        left: pos.x,
        top: pos.y,
        width: FAB_SIZE,
        height: FAB_SIZE,
        touchAction: 'none',
      }}
      className={cn(
        'fixed z-40 flex items-center justify-center rounded-full bg-text-primary text-white shadow-lg',
        dragging ? 'scale-110 cursor-grabbing opacity-90' : 'cursor-grab transition-transform active:scale-95',
      )}
    >
      <LockIcon width={22} height={22} />
    </button>
  );
}

/** Botão flutuante (cadeado) + área restrita. */
export function BlockFab() {
  const token = useBlockAccess((s) => s.token);
  const [open, setOpen] = useState(false);

  const isUnlocked = Boolean(token);

  return (
    <>
      <DraggableLockButton onTap={() => setOpen(true)} />

      {open && !isUnlocked && (
        <BlockUnlockModal open onClose={() => setOpen(false)} />
      )}

      {open && isUnlocked && (
        <Modal
          open
          onClose={() => setOpen(false)}
          title="Números bloqueados"
        >
          <div className="flex flex-col gap-3">
            <BlockedNumbersManager />
            <button
              onClick={() => {
                clearBlockToken();
                setOpen(false);
                toast('Área bloqueada novamente.', 'info');
              }}
              className="self-start text-sm font-medium text-text-secondary underline"
            >
              Bloquear área (sair)
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
