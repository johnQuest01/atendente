export type UserRole = 'admin' | 'operator';

export interface User {
  id: string;
  name: string;
  email: string;
  password_hash: string;
  role: UserRole;
  created_at: string;
}

export type PublicUser = Omit<User, 'password_hash'>;

export interface Client {
  id: string;
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
  client_id: string;
  status: ConversationStatus;
  assigned_to: string | null;
  started_at: string;
  closed_at: string | null;
  metadata: Record<string, unknown>;
}

export type MessageDirection = 'inbound' | 'outbound';
export type MessageType = 'text' | 'audio' | 'image' | 'document';

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
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}
