import { Link } from 'react-router-dom';
import type { ConversationListItem } from '@/types';
import { formatRelative, initials } from '@/utils/formatters';
import { cn } from '@/utils/cn';

const previewByType: Record<string, string> = {
  audio: '🎙️ Áudio',
  image: '🖼️ Imagem',
  document: '📎 Documento',
};

export function ConversationCard({ conversation }: { conversation: ConversationListItem }) {
  const name = conversation.client_name ?? conversation.company_name ?? conversation.client_phone;
  const preview =
    conversation.last_message_type && conversation.last_message_type !== 'text'
      ? previewByType[conversation.last_message_type] ?? '...'
      : conversation.last_message ?? 'Sem mensagens ainda';
  const hasUnread = conversation.unread_count > 0;

  return (
    <Link
      to={`/conversas/${conversation.id}`}
      className="tap-scale flex items-center gap-3 px-4 py-3 transition-colors hover:bg-black/[0.02]"
    >
      <div className="relative flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-primary-light text-sm font-semibold text-primary">
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
