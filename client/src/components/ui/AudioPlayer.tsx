import { useEffect, useRef, useState } from 'react';
import { formatDuration } from '@/utils/formatters';
import { cn } from '@/utils/cn';

interface AudioPlayerProps {
  src: string;
  durationSeconds?: number | null;
  variant?: 'light' | 'dark';
  className?: string;
}

export function AudioPlayer({ src, durationSeconds, variant = 'light', className }: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(durationSeconds ?? 0);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const onTime = () => setProgress(audio.currentTime);
    const onMeta = () => {
      if (Number.isFinite(audio.duration)) setDuration(audio.duration);
    };
    const onEnd = () => {
      setPlaying(false);
      setProgress(0);
    };
    audio.addEventListener('timeupdate', onTime);
    audio.addEventListener('loadedmetadata', onMeta);
    audio.addEventListener('ended', onEnd);
    return () => {
      audio.removeEventListener('timeupdate', onTime);
      audio.removeEventListener('loadedmetadata', onMeta);
      audio.removeEventListener('ended', onEnd);
    };
  }, []);

  function toggle() {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) {
      audio.pause();
      setPlaying(false);
    } else {
      void audio.play();
      setPlaying(true);
    }
  }

  const pct = duration > 0 ? Math.min(100, (progress / duration) * 100) : 0;
  const isDark = variant === 'dark';

  return (
    <div className={cn('flex items-center gap-3 rounded-full px-2 py-1.5', isDark ? 'bg-white/15' : 'bg-primary-light', className)}>
      <audio ref={audioRef} src={src} preload="metadata" />
      <button
        onClick={toggle}
        className={cn(
          'tap-scale flex h-9 w-9 shrink-0 items-center justify-center rounded-full',
          isDark ? 'bg-white text-primary' : 'bg-primary text-white',
        )}
        aria-label={playing ? 'Pausar' : 'Reproduzir'}
      >
        {playing ? (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <rect x="6" y="5" width="4" height="14" rx="1" />
            <rect x="14" y="5" width="4" height="14" rx="1" />
          </svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M8 5v14l11-7z" />
          </svg>
        )}
      </button>
      <div className="flex flex-1 items-center gap-2">
        <div className={cn('h-1 flex-1 overflow-hidden rounded-full', isDark ? 'bg-white/30' : 'bg-primary/20')}>
          <div className={cn('h-full rounded-full', isDark ? 'bg-white' : 'bg-primary')} style={{ width: `${pct}%` }} />
        </div>
        <span className={cn('w-10 text-right text-xs tabular-nums', isDark ? 'text-white/90' : 'text-text-secondary')}>
          {formatDuration(playing || progress > 0 ? progress : duration)}
        </span>
      </div>
    </div>
  );
}
