import { useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Toggle } from '@/components/ui/Toggle';
import { Badge } from '@/components/ui/Badge';
import { useSafeModeStatus, useSetSafeMode } from '@/hooks/useSafeMode';
import { toast } from '@/store/appStore';
import { getErrorMessage } from '@/services/api';

/** Toggle SAFE_MODE com confirmação ao desligar (só admin no PUT). */
export function SafeModeCard({ canEdit }: { canEdit: boolean }) {
  const { data } = useSafeModeStatus();
  const setSafe = useSetSafeMode();
  const [confirmOff, setConfirmOff] = useState(false);
  const safeOn = data?.enabled ?? true;

  async function confirmDisable() {
    try {
      await setSafe.mutateAsync(false);
      setConfirmOff(false);
      toast('Modo seguro desligado. Você assume o risco dos envios.', 'info');
    } catch (err) {
      toast(getErrorMessage(err), 'error');
    }
  }

  return (
    <>
      <div
        className={
          safeOn
            ? 'rounded-2xl border-2 border-success/30 bg-surface p-4'
            : 'rounded-2xl border-2 border-danger/40 bg-surface p-4'
        }
      >
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="text-base font-bold text-text-primary">Modo seguro (inbound-only)</h2>
              <Badge tone={safeOn ? 'success' : 'danger'}>{safeOn ? 'Ligado' : 'Desligado'}</Badge>
            </div>
            <p className="mt-1 text-sm text-text-secondary">
              {safeOn
                ? 'Ligado: o sistema só responde quem chama. Sem disparo, follow-up ou cutucar.'
                : 'Desligado: envios proativos liberados. Você assume o risco de ban.'}
            </p>
          </div>
          <Toggle
            checked={safeOn}
            disabled={setSafe.isPending || !canEdit}
            onChange={(next) => {
              if (!next) setConfirmOff(true);
              else {
                void setSafe
                  .mutateAsync(true)
                  .then(() => toast('Modo seguro ligado.', 'success'))
                  .catch((err) => toast(getErrorMessage(err), 'error'));
              }
            }}
            label="Modo seguro inbound-only"
          />
        </div>
      </div>

      <Modal
        open={confirmOff}
        onClose={() => setConfirmOff(false)}
        title="Desligar modo seguro?"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setConfirmOff(false)}>
              Cancelar
            </Button>
            <Button variant="danger" loading={setSafe.isPending} onClick={() => void confirmDisable()}>
              Desligar e assumir risco
            </Button>
          </div>
        }
      >
        <p className="text-sm text-text-secondary">
          Sem a trava o sistema não impede nenhum envio, inclusive os que causam ban (disparo,
          follow-up, cutucar). Você assume o risco.
        </p>
      </Modal>
    </>
  );
}
