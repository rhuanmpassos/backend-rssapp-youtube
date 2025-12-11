/**
 * Tipo do conteúdo de vídeo
 */
export type VideoType = 'video' | 'short' | 'live' | 'scheduled' | 'vod';

/**
 * Informações de um vídeo
 */
export interface VideoInfo {
  videoId: string;
  title: string;
  publishedAt: Date;
  thumbnailUrl: string;
  type: VideoType;
  duration?: number;           // segundos
  scheduledStartTime?: Date;   // para lives programadas
  isLive: boolean;
  isLiveContent: boolean;
  isUpcoming: boolean;
}

/**
 * Informações de um canal
 */
export interface ChannelInfo {
  channelId: string;
  title: string;
  description?: string;
  thumbnailUrl?: string;
}

/**
 * Opções de scraping
 */
export interface ScrapeOptions {
  /** Incluir vídeos regulares */
  includeVideos?: boolean;
  /** Incluir shorts */
  includeShorts?: boolean;
  /** Incluir lives e VODs */
  includeLives?: boolean;
  /** Classificar tipo de cada vídeo (requer request adicional por vídeo) */
  classifyVideos?: boolean;
  /** Número máximo de vídeos por feed */
  maxVideosPerFeed?: number;
}

/**
 * Opções do cliente HTTP
 */
export interface HttpClientOptions {
  /** Delay mínimo entre requests (ms) */
  minDelay?: number;
  /** Delay máximo entre requests (ms) */
  maxDelay?: number;
  /** Número máximo de requests simultâneos */
  maxConcurrent?: number;
  /** Número máximo de tentativas */
  maxRetries?: number;
  /** Timeout por request (ms) */
  timeout?: number;
}

/**
 * Dados do RSS item
 */
export interface RSSItem {
  videoId: string;
  title: string;
  publishedAt: Date;
  updatedAt: Date;
  thumbnailUrl: string;
  description?: string;
  viewCount?: number;
}

/**
 * Dados do player response do YouTube
 */
export interface YTPlayerResponse {
  isLive?: boolean;
  isLiveContent?: boolean;
  isUpcoming?: boolean;
  duration?: number;
  scheduledStartTime?: Date;
}

/**
 * Tipo de feed RSS do YouTube
 */
export type FeedType = 'videos' | 'lives' | 'shorts';

