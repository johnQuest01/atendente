import { useState } from 'react';
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

/** Botão flutuante (cadeado) presente em todas as telas. */
export function BlockFab() {
  const token = useBlockAccess((s) => s.token);
  const [open, setOpen] = useState(false);

  const isUnlocked = Boolean(token);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        aria-label="Números bloqueados (área restrita)"
        title="Números bloqueados"
        className="fixed bottom-24 right-4 z-30 flex h-12 w-12 items-center justify-center rounded-full bg-text-primary text-white shadow-lg transition-transform active:scale-95 md:bottom-6"
      >
        <LockIcon width={22} height={22} />
      </button>

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
