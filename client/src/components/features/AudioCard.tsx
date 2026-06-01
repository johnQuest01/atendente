import type { Audio } from '@/types';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { AudioPlayer } from '@/components/ui/AudioPlayer';
import { TrashIcon, EditIcon } from '@/components/ui/Icons';

interface AudioCardProps {
  audio: Audio;
  onDelete?: (audio: Audio) => void;
  onEdit?: (audio: Audio) => void;
  onSend?: (audio: Audio) => void;
}

export function AudioCard({ audio, onDelete, onEdit, onSend }: AudioCardProps) {
  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate font-semibold text-text-primary">{audio.title}</h3>
          <p className="truncate text-xs text-text-secondary">{audio.situation ?? audio.category}</p>
        </div>
        <div className="flex shrink-0 items-center">
          {onEdit && (
            <button
              onClick={() => onEdit(audio)}
              className="tap-scale rounded-full p-1.5 text-text-secondary hover:bg-primary/10 hover:text-primary"
              aria-label="Editar áudio"
            >
              <EditIcon width={18} height={18} />
            </button>
          )}
          {onDelete && (
            <button
              onClick={() => onDelete(audio)}
              className="tap-scale rounded-full p-1.5 text-text-secondary hover:bg-danger/10 hover:text-danger"
              aria-label="Excluir áudio"
            >
              <TrashIcon width={18} height={18} />
            </button>
          )}
        </div>
      </div>

      <AudioPlayer src={audio.file_url} durationSeconds={audio.duration_seconds} />

      {audio.keywords.length > 0 && (
        <p className="text-xs text-text-secondary">
          <span className="font-semibold text-text-primary">Dispara com:</span> {audio.keywords.join(', ')}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone="primary">{audio.category}</Badge>
        {audio.tone && <Badge tone="neutral">{audio.tone}</Badge>}
        {!audio.is_active && <Badge tone="danger">inativo</Badge>}
        <span className="ml-auto text-xs text-text-secondary">{audio.usage_count} usos</span>
      </div>

      {onSend && (
        <button
          onClick={() => onSend(audio)}
          className="tap-scale rounded-xl bg-primary-light py-2 text-sm font-semibold text-primary"
        >
          Enviar na conversa
        </button>
      )}
    </Card>
  );
}
