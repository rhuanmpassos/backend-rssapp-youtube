/**
 * Schema do banco de dados para o sistema de monitoramento (PostgreSQL)
 */

/**
 * SQL para criar as tabelas (PostgreSQL)
 */
export const CREATE_TABLES_SQL = `
-- Tabela de canais monitorados
CREATE TABLE IF NOT EXISTS channels (
  id SERIAL PRIMARY KEY,
  channel_id TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  thumbnail_url TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_checked_at TIMESTAMP,
  is_active INTEGER DEFAULT 1
);

-- Tabela de vídeos
CREATE TABLE IF NOT EXISTS videos (
  id SERIAL PRIMARY KEY,
  video_id TEXT UNIQUE NOT NULL,
  channel_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  thumbnail_url TEXT,
  published_at TIMESTAMP,
  type TEXT CHECK(type IN ('video', 'short', 'live', 'scheduled', 'vod')) NOT NULL,
  duration INTEGER,
  scheduled_start_time TIMESTAMP,
  is_live INTEGER DEFAULT 0,
  is_live_content INTEGER DEFAULT 0,
  is_upcoming INTEGER DEFAULT 0,
  bookmarked INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (channel_id) REFERENCES channels(channel_id)
);

-- Tabela de feeds RSS gerados (cache)
CREATE TABLE IF NOT EXISTS rss_feeds (
  id SERIAL PRIMARY KEY,
  channel_id TEXT UNIQUE NOT NULL,
  feed_xml TEXT NOT NULL,
  generated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (channel_id) REFERENCES channels(channel_id)
);

-- Tabela de eventos/histórico (para tracking de mudanças)
CREATE TABLE IF NOT EXISTS events (
  id SERIAL PRIMARY KEY,
  event_type TEXT CHECK(event_type IN ('new_video', 'live_started', 'live_ended', 'scheduled_live', 'video_updated')) NOT NULL,
  video_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  data TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (video_id) REFERENCES videos(video_id),
  FOREIGN KEY (channel_id) REFERENCES channels(channel_id)
);

-- Índices para performance
CREATE INDEX IF NOT EXISTS idx_videos_channel_id ON videos(channel_id);
CREATE INDEX IF NOT EXISTS idx_videos_type ON videos(type);
CREATE INDEX IF NOT EXISTS idx_videos_is_live ON videos(is_live);
CREATE INDEX IF NOT EXISTS idx_videos_published_at ON videos(published_at);
CREATE INDEX IF NOT EXISTS idx_videos_bookmarked ON videos(bookmarked);
CREATE INDEX IF NOT EXISTS idx_events_channel_id ON events(channel_id);
CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at);
CREATE INDEX IF NOT EXISTS idx_events_event_type ON events(event_type);
`;

/**
 * Tipos TypeScript para o banco de dados
 */
export interface DBChannel {
  id: number;
  channel_id: string;
  title: string;
  description: string | null;
  thumbnail_url: string | null;
  created_at: string;
  updated_at: string;
  last_checked_at: string | null;
  is_active: number;
}

export interface DBVideo {
  id: number;
  video_id: string;
  channel_id: string;
  title: string;
  description: string | null;
  thumbnail_url: string;
  published_at: string;
  type: 'video' | 'short' | 'live' | 'scheduled' | 'vod';
  duration: number | null;
  scheduled_start_time: string | null;
  is_live: number;
  is_live_content: number;
  is_upcoming: number;
  bookmarked: number;
  created_at: string;
  updated_at: string;
}

export interface DBRSSFeed {
  id: number;
  channel_id: string;
  feed_xml: string;
  generated_at: string;
}

export interface DBEvent {
  id: number;
  event_type: 'new_video' | 'live_started' | 'live_ended' | 'scheduled_live' | 'video_updated';
  video_id: string;
  channel_id: string;
  data: string | null;
  created_at: string;
}

export type EventType = DBEvent['event_type'];
