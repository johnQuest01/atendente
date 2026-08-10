import { useRef, useState } from 'react';
import type { MessageLog } from '@/types';
import { AudioPlayer } from '@/components/ui/AudioPlayer';
import { ImageLightbox } from '@/components/features/ImageLightbox';
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
  // A mídia vem de media_url (re-hospedada). Para mensagens antigas, ainda
  // aceitamos uma URL salva no próprio content. Legenda = content que não é URL.
  const isUrl = (s: string | null): boolean => !!s && /^https?:\/\//i.test(s);
  const mediaSrc: string | undefined =
    message.media_url ?? (isUrl(message.content) ? (message.content as string) : undefined);
  const rawCaption =
    message.content && message.content !== message.media_url && !isUrl(message.content)
      ? message.content
      : null;
  const isSticker =
    message.type === 'image' &&
    (/webp|gif/i.test(message.media_mime ?? '') ||
      /figurinha/i.test(rawCaption ?? '') ||
      rawCaption === '[image enviado pelo operador]');
  const caption =
    rawCaption && !/^\[(figurinha|image) enviado pelo operador\]$/i.test(rawCaption)
      ? rawCaption
      : null;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressedRef = useRef(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);

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
          isSticker && 'bg-transparent px-1 py-1 shadow-none',
          !isSticker &&
            (outbound
              ? 'rounded-br-md bg-primary text-white'
              : 'rounded-bl-md bg-surface text-text-primary'),
          selected && 'ring-2 ring-primary',
        )}
      >
        {message.type === 'audio' &&
          (mediaSrc ? (
            <AudioPlayer src={mediaSrc} variant={outbound ? 'dark' : 'light'} className="w-56" />
          ) : (
            <p className="text-[13px] italic opacity-80">🎙️ Áudio</p>
          ))}
        {message.type === 'audio' && message.transcription && (
          <p
            className={cn(
              'mt-1 whitespace-pre-wrap break-words text-[13px] leading-snug',
              outbound ? 'text-white/80' : 'text-text-secondary',
            )}
          >
            {message.transcription}
          </p>
        )}

        {message.type === 'image' && mediaSrc && (
          <>
            <button
              type="button"
              className="block w-full overflow-hidden rounded-xl text-left"
              aria-label="Ampliar imagem"
              onClick={(e) => {
                e.stopPropagation();
                if (selectionMode) {
                  onToggleSelect?.(message.id);
                  return;
                }
                if (longPressedRef.current) {
                  longPressedRef.current = false;
                  return;
                }
                setLightboxOpen(true);
              }}
            >
              <img
                src={mediaSrc}
                alt={caption ?? (isSticker ? 'Figurinha' : 'Imagem')}
                className={cn(
                  'cursor-zoom-in',
                  isSticker
                    ? 'max-h-44 max-w-[11rem] object-contain'
                    : 'max-h-64 w-full rounded-xl object-cover',
                )}
                loading="lazy"
                draggable={false}
              />
            </button>
            <ImageLightbox
              src={mediaSrc}
              alt={caption ?? (isSticker ? 'Figurinha' : 'Imagem')}
              open={lightboxOpen}
              onClose={() => setLightboxOpen(false)}
            />
          </>
        )}
        {message.type === 'image' && !mediaSrc && (
          <p className="text-[13px] italic opacity-80">{isSticker ? '🎭 Figurinha' : '🖼️ Imagem'}</p>
        )}

        {message.type === 'video' && mediaSrc && (
          <video src={mediaSrc} controls preload="metadata" className="max-h-72 w-full rounded-xl" />
        )}

        {message.type === 'document' &&
          (mediaSrc ? (
            <a
              href={mediaSrc}
              target="_blank"
              rel="noreferrer"
              className={cn(
                'flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium underline-offset-2 hover:underline',
                outbound ? 'bg-white/15 text-white' : 'bg-primary-light text-primary',
              )}
            >
              <span aria-hidden>📎</span>
              <span className="max-w-[12rem] truncate">{caption ?? 'Abrir documento'}</span>
            </a>
          ) : (
            <p className="whitespace-pre-wrap break-words text-[15px] leading-snug">
              {message.content ?? '📎 Documento'}
            </p>
          ))}

        {(message.type === 'image' || message.type === 'video') && caption && (
          <p className="mt-1 whitespace-pre-wrap break-words text-[15px] leading-snug">{caption}</p>
        )}

        {message.type === 'text' && (
          <p className="whitespace-pre-wrap break-words text-[15px] leading-snug">{message.content}</p>
        )}

        <div
          className={cn(
            'mt-1 flex items-center justify-end gap-1 text-[10px]',
            isSticker || !outbound ? 'text-text-secondary' : 'text-white/70',
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
