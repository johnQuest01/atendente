import { useEffect, useMemo, useState } from 'react';
import { PageHeader } from '@/components/layout/AppShell';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Input, TextArea } from '@/components/ui/Input';
import { FileUpload } from '@/components/ui/FileUpload';
import { AudioPlayer } from '@/components/ui/AudioPlayer';
import { AudioCard } from '@/components/features/AudioCard';
import { Spinner, ErrorState, EmptyState } from '@/components/ui/States';
import { AudioIcon, PlusIcon } from '@/components/ui/Icons';
import {
  useAudios,
  useDeleteAudio,
  useUploadAudio,
  useUpdateAudio,
  useReplaceAudioFile,
} from '@/hooks/useAudios';
import { useAudioRecorder } from '@/hooks/useAudioRecorder';
import { toast } from '@/store/appStore';
import { getErrorMessage } from '@/services/api';
import type { Audio } from '@/types';

export default function Audios() {
  const { data, isLoading, isError, refetch } = useAudios();
  const deleteAudio = useDeleteAudio();
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Audio | null>(null);

  const grouped = useMemo(() => {
    const map = new Map<string, Audio[]>();
    for (const a of data ?? []) {
      const list = map.get(a.category) ?? [];
      list.push(a);
      map.set(a.category, list);
    }
    return Array.from(map.entries());
  }, [data]);

  async function handleDelete(audio: Audio) {
    if (!confirm(`Excluir o áudio "${audio.title}"?`)) return;
    try {
      await deleteAudio.mutateAsync(audio.id);
      toast('Áudio excluído.', 'success');
    } catch (err) {
      toast(getErrorMessage(err), 'error');
    }
  }

  return (
    <>
      <PageHeader
        title="Áudios"
        subtitle="Gravados pela Mayra"
        action={
          <Button size="sm" onClick={() => setModalOpen(true)}>
            <PlusIcon width={18} height={18} /> Novo
          </Button>
        }
      />

      {isLoading && <Spinner label="Carregando áudios..." />}
      {isError && <ErrorState message="Erro ao carregar áudios." onRetry={() => void refetch()} />}

      {data && data.length === 0 && (
        <EmptyState
          icon={<AudioIcon width={40} height={40} />}
          title="Nenhum áudio ainda"
          description="Grave ou envie áudios para a IA usar nas conversas."
          action={<Button onClick={() => setModalOpen(true)}>Adicionar áudio</Button>}
        />
      )}

      <div className="flex flex-col gap-5 p-4">
        {grouped.map(([category, audios]) => (
          <section key={category}>
            <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-text-secondary">{category}</h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {audios.map((a) => (
                <AudioCard key={a.id} audio={a} onDelete={handleDelete} onEdit={setEditing} />
              ))}
            </div>
          </section>
        ))}
      </div>

      <UploadAudioModal open={modalOpen} onClose={() => setModalOpen(false)} />
      <EditAudioModal audio={editing} onClose={() => setEditing(null)} />
    </>
  );
}

function UploadAudioModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const upload = useUploadAudio();
  const recorder = useAudioRecorder();
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('');
  const [tone, setTone] = useState('');
  const [situation, setSituation] = useState('');
  const [transcription, setTranscription] = useState('');
  const [keywords, setKeywords] = useState('');

  const effectiveFile = file ?? recorder.file;
  const previewUrl = useMemo(() => (effectiveFile ? URL.createObjectURL(effectiveFile) : null), [effectiveFile]);

  function reset() {
    setFile(null);
    recorder.reset();
    setTitle('');
    setCategory('');
    setTone('');
    setSituation('');
    setTranscription('');
    setKeywords('');
  }

  async function handleSubmit() {
    if (!effectiveFile) return toast('Grave ou selecione um áudio.', 'error');
    if (!title.trim() || !category.trim()) return toast('Título e categoria são obrigatórios.', 'error');

    const form = new FormData();
    form.append('file', effectiveFile, effectiveFile.name || 'gravacao.webm');
    form.append('title', title.trim());
    form.append('category', category.trim());
    if (tone) form.append('tone', tone.trim());
    if (situation) form.append('situation', situation.trim());
    if (transcription) form.append('transcription', transcription.trim());
    if (keywords) form.append('keywords', keywords);

    try {
      await upload.mutateAsync(form);
      toast('Áudio adicionado!', 'success');
      reset();
      onClose();
    } catch (err) {
      toast(getErrorMessage(err, 'Falha no upload.'), 'error');
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Novo áudio"
      footer={
        <Button fullWidth loading={upload.isPending} onClick={handleSubmit}>
          Salvar áudio
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <button
            onClick={recorder.recording ? recorder.stop : recorder.start}
            className={`tap-scale flex items-center justify-center gap-2 rounded-2xl py-3 font-semibold text-white ${
              recorder.recording ? 'bg-danger' : 'bg-primary'
            }`}
          >
            <span className={recorder.recording ? 'animate-pulse' : ''}>●</span>
            {recorder.recording ? `Gravando... ${recorder.seconds}s (toque para parar)` : 'Gravar pelo microfone'}
          </button>
          <p className="text-center text-xs text-text-secondary">ou</p>
          <FileUpload accept="audio/*" onFiles={(files) => setFile(files[0] ?? null)} />
        </div>

        {previewUrl && (
          <div className="rounded-xl bg-bg p-3">
            <AudioPlayer src={previewUrl} />
            <p className="mt-1 truncate text-center text-xs text-text-secondary">
              {effectiveFile?.name || 'gravacao.webm'}
            </p>
          </div>
        )}

        <Input label="Título" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Ex: Boas-vindas" />
        <Input label="Categoria" value={category} onChange={(e) => setCategory(e.target.value)} placeholder="duvida_preco" />
        <Input label="Tom de voz" value={tone} onChange={(e) => setTone(e.target.value)} placeholder="empatico" />
        <Input label="Quando usar" value={situation} onChange={(e) => setSituation(e.target.value)} placeholder="Cliente pergunta preço" />
        <TextArea label="Transcrição" value={transcription} onChange={(e) => setTranscription(e.target.value)} placeholder="O que é falado no áudio" />
        <div>
          <Input
            label="Palavras-chave que disparam este áudio (separe por vírgula)"
            value={keywords}
            onChange={(e) => setKeywords(e.target.value)}
            placeholder="boa noite, com que voce trabalha, oi"
          />
          <p className="mt-1 text-xs text-text-secondary">
            Quando o cliente escrever (ou falar) qualquer uma dessas palavras, a Mayra envia este áudio automaticamente.
          </p>
        </div>
      </div>
    </Modal>
  );
}

function EditAudioModal({ audio, onClose }: { audio: Audio | null; onClose: () => void }) {
  const update = useUpdateAudio();
  const replaceFile = useReplaceAudioFile();
  const recorder = useAudioRecorder();
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('');
  const [situation, setSituation] = useState('');
  const [transcription, setTranscription] = useState('');
  const [keywords, setKeywords] = useState('');
  const [isActive, setIsActive] = useState(true);
  const [newFile, setNewFile] = useState<File | null>(null);

  const effectiveNew = newFile ?? recorder.file;
  const newPreview = useMemo(
    () => (effectiveNew ? URL.createObjectURL(effectiveNew) : null),
    [effectiveNew],
  );

  useEffect(() => {
    if (audio) {
      setTitle(audio.title);
      setCategory(audio.category);
      setSituation(audio.situation ?? '');
      setTranscription(audio.transcription ?? '');
      setKeywords(audio.keywords.join(', '));
      setIsActive(audio.is_active);
      setNewFile(null);
      recorder.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audio]);

  function close() {
    setNewFile(null);
    recorder.reset();
    onClose();
  }

  async function handleSave() {
    if (!audio) return;
    if (!title.trim() || !category.trim()) return toast('Título e categoria são obrigatórios.', 'error');
    const patch: Partial<Audio> = {
      title: title.trim(),
      category: category.trim(),
      situation: situation.trim() || null,
      transcription: transcription.trim() || null,
      keywords: keywords
        .split(',')
        .map((k) => k.trim())
        .filter(Boolean),
      is_active: isActive,
    };
    try {
      await update.mutateAsync({ id: audio.id, patch });
      if (effectiveNew) {
        const form = new FormData();
        form.append('file', effectiveNew, effectiveNew.name || 'gravacao.webm');
        await replaceFile.mutateAsync({ id: audio.id, formData: form });
        toast('Áudio atualizado e arquivo substituído!', 'success');
      } else {
        toast('Áudio atualizado!', 'success');
      }
      close();
    } catch (err) {
      toast(getErrorMessage(err), 'error');
    }
  }

  return (
    <Modal
      open={Boolean(audio)}
      onClose={close}
      title="Editar áudio"
      footer={
        <Button fullWidth loading={update.isPending || replaceFile.isPending} onClick={handleSave}>
          Salvar alterações
        </Button>
      }
    >
      {audio && (
        <div className="flex flex-col gap-4">
          <div className="rounded-xl bg-bg p-3">
            <AudioPlayer src={audio.file_url} durationSeconds={audio.duration_seconds} />
          </div>

          <div className="flex flex-col gap-2 rounded-xl border border-dashed border-border p-3">
            <p className="text-sm font-semibold text-text-primary">Substituir áudio (opcional)</p>
            <p className="text-xs text-text-secondary">
              Grave de novo ou envie outro arquivo. As palavras-chave e os demais dados são mantidos.
            </p>
            <button
              type="button"
              onClick={recorder.recording ? recorder.stop : recorder.start}
              className={`tap-scale flex items-center justify-center gap-2 rounded-2xl py-3 font-semibold text-white ${
                recorder.recording ? 'bg-danger' : 'bg-primary'
              }`}
            >
              <span className={recorder.recording ? 'animate-pulse' : ''}>●</span>
              {recorder.recording
                ? `Gravando... ${recorder.seconds}s (toque para parar)`
                : 'Gravar pelo microfone'}
            </button>
            <p className="text-center text-xs text-text-secondary">ou</p>
            <FileUpload accept="audio/*" onFiles={(files) => setNewFile(files[0] ?? null)} />
            {newPreview && (
              <div className="rounded-xl bg-bg p-3">
                <AudioPlayer src={newPreview} />
                <p className="mt-1 truncate text-center text-xs text-text-secondary">
                  Novo: {effectiveNew?.name || 'gravacao.webm'}
                </p>
              </div>
            )}
          </div>

          <Input label="Título" value={title} onChange={(e) => setTitle(e.target.value)} />
          <Input label="Categoria" value={category} onChange={(e) => setCategory(e.target.value)} />
          <Input label="Quando usar" value={situation} onChange={(e) => setSituation(e.target.value)} />
          <TextArea label="Transcrição" value={transcription} onChange={(e) => setTranscription(e.target.value)} />
          <div>
            <Input
              label="Palavras-chave que disparam este áudio (separe por vírgula)"
              value={keywords}
              onChange={(e) => setKeywords(e.target.value)}
              placeholder="boa noite, com que voce trabalha, oi"
            />
            <p className="mt-1 text-xs text-text-secondary">
              Quando o cliente escrever (ou falar) qualquer uma dessas palavras, a Mayra envia este áudio automaticamente.
            </p>
          </div>
          <label className="flex items-center gap-2 text-sm text-text-primary">
            <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
            Áudio ativo (disponível para envio)
          </label>
        </div>
      )}
    </Modal>
  );
}
