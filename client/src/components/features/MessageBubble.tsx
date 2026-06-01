import { useRef } from 'react';
import type { MessageLog } from '@/types';
import { AudioPlayer } from '@/components/ui/AudioPlayer';
import { formatTime } from '@/utils/formatters';
import { cn } from '@/utils/cn';

interface MessageBubbleProps {
  message: MessageLog;
  selectionMode?: boolean;
  selected?: boolean;
  onLongPress?: (id: string) => void;
  onToggleSelect?: (id: string) => void;
}

const LONG_PRESS_MS = 450;

export function MessageBubble({
  message,
  selectionMode = false,
  selected = false,
  onLongPress,
  onToggleSelect,
}: MessageBubbleProps) {
  const outbound = message.direction === 'outbound';
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressedRef = useRef(false);

  function startPress() {
    longPressedRef.current = false;
    timerRef.current = setTimeout(() => {
      longPressedRef.current = true;
      onLongPress?.(message.id);
    }, LONG_PRESS_MS);
  }

  function cancelPress() {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }

  function handleClick() {
    if (selectionMode) {
      onToggleSelect?.(message.id);
      return;
    }
    // Se foi um long-press, o clique subsequente é ignorado.
    longPressedRef.current = false;
  }

  return (
    <div
      className={cn(
        'flex w-full select-none items-center gap-2',
        outbound ? 'justify-end' : 'justify-start',
        selectionMode && 'cursor-pointer rounded-lg px-1 py-0.5',
        selected && 'bg-primary/10',
      )}
      onClick={handleClick}
      onPointerDown={startPress}
      onPointerUp={cancelPress}
      onPointerLeave={cancelPress}
      onContextMenu={(e) => {
        if (onLongPress) {
          e.preventDefault();
          onLongPress(message.id);
        }
      }}
    >
      {selectionMode && !outbound && (
        <SelectDot selected={selected} />
      )}
      <div
        className={cn(
          'max-w-[78%] rounded-2xl px-3 py-2 shadow-sm',
          outbound
            ? 'rounded-br-md bg-primary text-white'
            : 'rounded-bl-md bg-surface text-text-primary',
          selected && 'ring-2 ring-primary',
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
            draggable={false}
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
      {selectionMode && outbound && <SelectDot selected={selected} />}
    </div>
  );
}

function SelectDot({ selected }: { selected: boolean }) {
  return (
    <span
      className={cn(
        'flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 text-[10px] text-white transition-colors',
        selected ? 'border-primary bg-primary' : 'border-text-secondary/50',
      )}
    >
      {selected ? '✓' : ''}
    </span>
  );
}
