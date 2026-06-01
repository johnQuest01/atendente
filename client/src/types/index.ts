export type UserRole = 'admin' | 'operator';

export interface User {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  created_at: string;
}

export type ConversationStatus = 'open' | 'closed' | 'waiting';
export type MessageDirection = 'inbound' | 'outbound';
export type MessageType = 'text' | 'audio' | 'image' | 'document';
export type ContentType = 'audio' | 'text' | 'product' | 'claude';

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

export interface Conversation {
  id: string;
  client_id: string;
  status: ConversationStatus;
  assigned_to: string | null;
  started_at: string;
  closed_at: string | null;
  metadata: Record<string, unknown>;
}

export interface ConversationListItem extends Conversation {
  client_name: string | null;
  client_phone: string;
  company_name: string | null;
  last_message: string | null;
  last_message_type: MessageType | null;
  last_message_at: string | null;
  unread_count: number;
}

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

export interface Keyword {
  id: string;
  keyword: string;
  intent: string;
  content_type: ContentType;
  content_id: string | null;
  priority: number;
  is_active: boolean;
}

export interface DashboardData {
  metrics: {
    open_conversations: number;
    waiting_conversations: number;
    messages_sent_today: number;
    messages_received_today: number;
    active_clients: number;
  };
  topAudios: Array<{ id: string; title: string; category: string; usage_count: number }>;
  activity: Array<{ hour: string; inbound: number; outbound: number }>;
}
