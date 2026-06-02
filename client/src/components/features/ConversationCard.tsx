import { useRef } from 'react';
import { Link } from 'react-router-dom';
import type { ConversationListItem } from '@/types';
import { formatRelative, initials } from '@/utils/formatters';
import { cn } from '@/utils/cn';

const previewByType: Record<string, string> = {
  audio: '🎙️ Áudio',
  image: '🖼️ Imagem',
  document: '📎 Documento',
};

// Gradientes para os avatares — cor consistente por contato (hash do texto).
const AVATAR_GRADIENTS = [
  'from-[#7C5CFF] to-[#5631E6]',
  'from-[#06B6D4] to-[#3B82F6]',
  'from-[#F472B6] to-[#DB2777]',
  'from-[#FB923C] to-[#EF4444]',
  'from-[#34D399] to-[#059669]',
  'from-[#A78BFA] to-[#EC4899]',
];

function avatarGradient(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  return AVATAR_GRADIENTS[Math.abs(hash) % AVATAR_GRADIENTS.length];
}

const LONG_PRESS_MS = 450;

interface ConversationCardProps {
  conversation: ConversationListItem;
  onLongPress?: (id: string) => void;
}

export function ConversationCard({ conversation, onLongPress }: ConversationCardProps) {
  const name = conversation.client_name ?? conversation.company_name ?? conversation.client_phone;
  const preview =
    conversation.last_message_type && conversation.last_message_type !== 'text'
      ? previewByType[conversation.last_message_type] ?? '...'
      : conversation.last_message ?? 'Sem mensagens ainda';
  const hasUnread = conversation.unread_count > 0;

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressedRef = useRef(false);

  function startPress() {
    longPressedRef.current = false;
    timerRef.current = setTimeout(() => {
      longPressedRef.current = true;
      onLongPress?.(conversation.id);
    }, LONG_PRESS_MS);
  }

  function cancelPress() {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }

  return (
    <Link
      to={`/conversas/${conversation.id}`}
      className="tap-scale flex select-none items-center gap-3 px-4 py-3 transition-colors hover:bg-black/[0.02]"
      onPointerDown={startPress}
      onPointerUp={cancelPress}
      onPointerLeave={cancelPress}
      onClick={(e) => {
        // Após um "segurar", o clique não deve navegar para a conversa.
        if (longPressedRef.current) {
          e.preventDefault();
          longPressedRef.current = false;
        }
      }}
      onContextMenu={(e) => {
        if (onLongPress) {
          e.preventDefault();
          onLongPress(conversation.id);
        }
      }}
    >
      <div
        className={cn(
          'relative flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-gradient-to-br text-sm font-bold text-white shadow-soft',
          avatarGradient(name),
        )}
      >
        {initials(conversation.client_name, conversation.client_phone)}
        {conversation.status === 'open' && (
          <span className="absolute -right-0.5 -top-0.5 h-3 w-3 rounded-full border-2 border-surface bg-success" />
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <p className="truncate font-semibold text-text-primary">{name}</p>
          <span className="shrink-0 text-xs text-text-secondary">
            {formatRelative(conversation.last_message_at)}
          </span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <p className={cn('truncate text-sm', hasUnread ? 'font-medium text-text-primary' : 'text-text-secondary')}>
            {preview}
          </p>
          {hasUnread && (
            <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-primary px-1.5 text-xs font-bold text-white">
              {conversation.unread_count}
            </span>
          )}
        </div>
      </div>
    </Link>
  );
}
