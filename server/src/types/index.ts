export type UserRole = 'admin' | 'operator' | 'superadmin';

export interface User {
  id: string;
  name: string;
  email: string;
  password_hash: string;
  role: UserRole;
  tenant_id: string;
  created_at: string;
}

export type PublicUser = Omit<User, 'password_hash'>;

export interface Client {
  id: string;
  tenant_id: string;
  phone: string;
  name: string | null;
  company_name: string | null;
  segment: string | null;
  notes: string | null;
  is_active: boolean;
  first_contact_at: string;
  last_contact_at: string;
}

export type ConversationStatus = 'open' | 'closed' | 'waiting';

export interface Conversation {
  id: string;
  tenant_id: string;
  client_id: string;
  status: ConversationStatus;
  assigned_to: string | null;
  started_at: string;
  closed_at: string | null;
  metadata: Record<string, unknown>;
  /** Até quando a IA fica pausada após intervenção humana (null = sem pausa). */
  human_paused_until: string | null;
}

export type MessageDirection = 'inbound' | 'outbound';
export type MessageType = 'text' | 'audio' | 'image' | 'video' | 'document';
/** Quem originou a mensagem no histórico. */
export type MessageOrigin = 'client' | 'ai' | 'human' | 'system';

export interface MessageLog {
  id: string;
  conversation_id: string;
  direction: MessageDirection;
  type: MessageType;
  content: string | null;
  audio_id: string | null;
  product_id: string | null;
  zapi_message_id: string | null;
  sent_at: string;
  delivered_at: string | null;
  read_at: string | null;
  /** URL pública estável da mídia re-hospedada (imagem/vídeo/áudio/documento). */
  media_url: string | null;
  /** Content-type da mídia (define como o painel renderiza/baixa). */
  media_mime: string | null;
  /** Transcrição do áudio (quando houver), separada do "content". */
  transcription: string | null;
  origin: MessageOrigin;
}

/** Mensagem do histórico enriquecida com dados para o contexto da IA. */
export interface AiHistoryMessage extends MessageLog {
  audio_transcription: string | null;
  audio_title: string | null;
  product_name: string | null;
}

export interface Audio {
  id: string;
  title: string;
  category: string;
  tone: string | null;
  situation: string | null;
  file_url: string;
  file_size_kb: number | null;
  duration_seconds: number | null;
  transcription: string | null;
  keywords: string[];
  usage_count: number;
  is_active: boolean;
  created_by: string | null;
  created_at: string;
  // Tipo do arquivo guardado no banco (ex.: 'audio/ogg').
  mime_type?: string | null;
  // Indica se há bytes do áudio salvos no banco (sem trazer o blob nas listas).
  has_file_data?: boolean;
}

export interface TextScript {
  id: string;
  title: string;
  category: string;
  content: string;
  keywords: string[];
  usage_count: number;
  is_active: boolean;
  created_by: string | null;
  created_at: string;
}

export interface Product {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  price_wholesale: string | null;
  min_quantity: number;
  unit: string | null;
  image_urls: string[];
  keywords: string[];
  is_available: boolean;
  created_at: string;
}

export type ContentType = 'audio' | 'text' | 'product' | 'claude';

/** Lembretes pessoais do dono (assistente por WhatsApp). */
export type ReminderCategory = 'importante' | 'rotina' | 'data_especifica';
export type ReminderStatus = 'pendente' | 'enviado' | 'concluido' | 'cancelado';

export interface Reminder {
  id: string;
  tenant_id: string;
  owner_phone: string;
  task: string;
  category: ReminderCategory;
  /** NULL = disparo único; senão 'daily' | 'weekly:FRI' | 'monthly:20'. */
  recurrence: string | null;
  next_fire_at: string;
  status: ReminderStatus;
  timezone: string;
  notes: string | null;
  last_fired_at: string | null;
  created_at: string;
}

export interface Keyword {
  id: string;
  keyword: string;
  intent: string;
  content_type: ContentType;
  content_id: string | null;
  priority: number;
  is_active: boolean;
}

export interface MatchResult {
  content_type: ContentType;
  content_id: string | null;
  intent: string;
  keyword?: string;
}

export interface JwtPayload {
  sub: string;
  email: string;
  role: UserRole;
  /** Empresa (tenant) à qual o usuário pertence. */
  tenant_id: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}
