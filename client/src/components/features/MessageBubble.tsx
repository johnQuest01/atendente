import type { MessageLog } from '@/types';
import { AudioPlayer } from '@/components/ui/AudioPlayer';
import { formatTime } from '@/utils/formatters';
import { cn } from '@/utils/cn';

export function MessageBubble({ message }: { message: MessageLog }) {
  const outbound = message.direction === 'outbound';

  return (
    <div className={cn('flex w-full', outbound ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[78%] rounded-2xl px-3 py-2 shadow-sm',
          outbound
            ? 'rounded-br-md bg-primary text-white'
            : 'rounded-bl-md bg-surface text-text-primary',
        )}
      >
        {message.type === 'audio' && message.content && (
          <AudioPlayer src={message.content} variant={outbound ? 'dark' : 'light'} className="w-56" />
        )}

        {message.type === 'image' && message.content && (
          <img
            src={message.content}
            alt="Imagem enviada"
            className="max-h-64 w-full rounded-xl object-cover"
            loading="lazy"
          />
        )}

        {(message.type === 'text' || message.type === 'document') && (
          <p className="whitespace-pre-wrap break-words text-[15px] leading-snug">{message.content}</p>
        )}

        <div
          className={cn(
            'mt-1 flex items-center justify-end gap-1 text-[10px]',
            outbound ? 'text-white/70' : 'text-text-secondary',
          )}
        >
          <span>{formatTime(message.sent_at)}</span>
          {outbound && (
            <span>{message.read_at ? '✓✓' : message.delivered_at ? '✓✓' : '✓'}</span>
          )}
        </div>
      </div>
    </div>
  );
}
