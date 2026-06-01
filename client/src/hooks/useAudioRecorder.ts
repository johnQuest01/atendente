import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from '@/store/appStore';

interface RecorderState {
  recording: boolean;
  seconds: number;
  file: File | null;
  start: () => Promise<void>;
  stop: () => void;
  reset: () => void;
}

/** Gravação de áudio via MediaRecorder (microfone do dispositivo). */
export function useAudioRecorder(): RecorderState {
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [file, setFile] = useState<File | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const start = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
        setFile(new File([blob], `gravacao-${Date.now()}.webm`, { type: 'audio/webm' }));
        stream.getTracks().forEach((t) => t.stop());
      };

      recorder.start();
      recorderRef.current = recorder;
      setSeconds(0);
      setRecording(true);
      timerRef.current = setInterval(() => setSeconds((s) => s + 1), 1000);
    } catch {
      toast('Não foi possível acessar o microfone.', 'error');
    }
  }, []);

  const stop = useCallback(() => {
    recorderRef.current?.stop();
    setRecording(false);
    clearTimer();
  }, [clearTimer]);

  const reset = useCallback(() => {
    setFile(null);
    setSeconds(0);
  }, []);

  useEffect(() => () => clearTimer(), [clearTimer]);

  return { recording, seconds, file, start, stop, reset };
}
