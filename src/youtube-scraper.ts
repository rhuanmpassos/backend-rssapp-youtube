import { 
  VideoInfo, 
  ChannelInfo, 
  ScrapeOptions, 
  HttpClientOptions,
  FeedType 
} from './types';
import { HttpClient } from './http-client';
import { extractChannelId, getChannelInfo } from './channel-extractor';
import { parseRSSFeed, getAllChannelVideos } from './rss-parser';
import { 
  getVideoClassification, 
  extractPlayerResponse, 
  classifyVideo 
} from './video-classifier';

/**
 * Opções padrão de scraping
 */
const DEFAULT_SCRAPE_OPTIONS: Required<ScrapeOptions> = {
  includeVideos: true,
  includeShorts: true,
  includeLives: true,
  classifyVideos: true,
  maxVideosPerFeed: 15,
};

/**
 * Classe principal do YouTube Scraper
 */
export class YouTubeScraper {
  private client: HttpClient;

  constructor(httpOptions?: HttpClientOptions) {
    this.client = new HttpClient(httpOptions);
  }

  /**
   * Obtém informações de um canal a partir de URL, handle ou ID
   */
  async getChannelInfo(urlOrHandle: string): Promise<ChannelInfo | null> {
    return getChannelInfo(urlOrHandle, this.client);
  }

  /**
   * Obtém apenas o Channel ID
   */
  async getChannelId(urlOrHandle: string): Promise<string | null> {
    return extractChannelId(urlOrHandle, this.client);
  }

  /**
   * Obtém lista de vídeos do canal via RSS
   */
  async getChannelVideos(
    channelId: string,
    options: ScrapeOptions = {}
  ): Promise<VideoInfo[]> {
    const opts = { ...DEFAULT_SCRAPE_OPTIONS, ...options };
    
    // Busca vídeos de todos os feeds
    const feedResults = await getAllChannelVideos(
      channelId,
      {
        includeVideos: opts.includeVideos,
        includeShorts: opts.includeShorts,
        includeLives: opts.includeLives,
      },
      this.client
    );

    const videos: VideoInfo[] = [];
    const feedHints = new Map<string, 'shorts' | 'lives'>();

    // Processa cada feed
    for (const [feedType, items] of feedResults) {
      const limitedItems = items.slice(0, opts.maxVideosPerFeed);
      
      for (const item of limitedItems) {
        // Adiciona hint do feed para classificação
        if (feedType === 'shorts') {
          feedHints.set(item.videoId, 'shorts');
        } else if (feedType === 'lives') {
          feedHints.set(item.videoId, 'lives');
        }

        videos.push({
          videoId: item.videoId,
          title: item.title,
          publishedAt: item.publishedAt,
          thumbnailUrl: item.thumbnailUrl,
          type: this.getTypeFromFeed(feedType),
          isLive: false,
          isLiveContent: feedType === 'lives',
          isUpcoming: false,
        });
      }
    }

    // Classifica cada vídeo se solicitado
    if (opts.classifyVideos) {
      await this.classifyVideosList(videos, feedHints);
    }

    // Remove duplicatas (mesmo vídeo pode aparecer em feeds diferentes)
    return this.deduplicateVideos(videos);
  }

  /**
   * Obtém detalhes de um vídeo específico
   */
  async getVideoDetails(videoId: string): Promise<VideoInfo | null> {
    try {
      const url = `https://www.youtube.com/watch?v=${videoId}`;
      const html = await this.client.get(url);
      
      const props = extractPlayerResponse(html);
      const type = classifyVideo(props);

      // Extrai título do HTML
      const titleMatch = html.match(/<meta name="title" content="([^"]+)">/);
      const title = titleMatch?.[1] || '';

      return {
        videoId,
        title: this.decodeHtmlEntities(title),
        publishedAt: new Date(), // RSS tem data mais precisa
        thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
        type,
        duration: props.duration,
        scheduledStartTime: props.scheduledStartTime,
        isLive: props.isLive || false,
        isLiveContent: props.isLiveContent || false,
        isUpcoming: props.isUpcoming || false,
      };
    } catch (error) {
      console.error(`Erro ao obter detalhes do vídeo ${videoId}:`, error);
      return null;
    }
  }

  /**
   * Verifica se há live ativa no canal (apenas 1 request)
   */
  async checkLiveStatus(channelId: string): Promise<VideoInfo | null> {
    try {
      // Verifica a página /live do canal (1 único request)
      const channelLiveUrl = `https://www.youtube.com/channel/${channelId}/live`;
      
      const html = await this.client.get(channelLiveUrl);
      const props = extractPlayerResponse(html);
      
      if (props.isLive) {
        // Extrai videoId da página
        const videoIdMatch = html.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
        const videoId = videoIdMatch?.[1];
        
        if (videoId) {
          // Extrai título do HTML
          const titleMatch = html.match(/<meta name="title" content="([^"]+)">/);
          const title = titleMatch?.[1] || '';
          
          return {
            videoId,
            title: this.decodeHtmlEntities(title),
            publishedAt: new Date(),
            thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
            type: 'live',
            duration: undefined,
            scheduledStartTime: props.scheduledStartTime,
            isLive: true,
            isLiveContent: false,
            isUpcoming: false,
          };
        }
      }

      return null;
    } catch (error) {
      // Página /live pode não existir ou estar bloqueada - isso é normal
      return null;
    }
  }

  /**
   * Busca lives programadas do canal
   */
  async getScheduledLives(channelId: string): Promise<VideoInfo[]> {
    const liveItems = await parseRSSFeed(channelId, 'lives', this.client);
    const scheduledLives: VideoInfo[] = [];

    for (const item of liveItems.slice(0, 10)) {
      const details = await this.getVideoDetails(item.videoId);
      
      if (details && details.isUpcoming) {
        scheduledLives.push({
          ...details,
          publishedAt: item.publishedAt,
        });
      }
    }

    return scheduledLives;
  }

  /**
   * Classifica lista de vídeos
   */
  private async classifyVideosList(
    videos: VideoInfo[],
    feedHints: Map<string, 'shorts' | 'lives'>
  ): Promise<void> {
    await Promise.all(
      videos.map(async video => {
        try {
          const hint = feedHints.get(video.videoId);
          const { type, props } = await getVideoClassification(
            video.videoId,
            hint,
            this.client
          );
          
          video.type = type;
          video.duration = props.duration;
          video.scheduledStartTime = props.scheduledStartTime;
          video.isLive = props.isLive || false;
          video.isLiveContent = props.isLiveContent || false;
          video.isUpcoming = props.isUpcoming || false;
        } catch (error) {
          // Mantém tipo inferido do feed
        }
      })
    );
  }

  /**
   * Converte tipo de feed para tipo de vídeo
   */
  private getTypeFromFeed(feedType: FeedType): VideoInfo['type'] {
    switch (feedType) {
      case 'shorts':
        return 'short';
      case 'lives':
        return 'vod';
      default:
        return 'video';
    }
  }

  /**
   * Remove vídeos duplicados, preferindo manter o que tem mais informações
   * Prioridade: isLive > isLiveContent > isUpcoming > primeiro encontrado
   */
  private deduplicateVideos(videos: VideoInfo[]): VideoInfo[] {
    const seen = new Map<string, VideoInfo>();
    
    for (const video of videos) {
      const existing = seen.get(video.videoId);
      
      if (!existing) {
        seen.set(video.videoId, video);
        continue;
      }
      
      // Prefere manter o vídeo com mais informações relevantes
      const shouldReplace = 
        // Se o novo está ao vivo e o existente não
        (video.isLive && !existing.isLive) ||
        // Se o novo é VOD (isLiveContent) e o existente não
        (video.isLiveContent && !existing.isLiveContent) ||
        // Se o novo é agendado e o existente não
        (video.isUpcoming && !existing.isUpcoming) ||
        // Se o novo tem tipo mais específico (vod > video)
        (video.type === 'vod' && existing.type === 'video') ||
        (video.type === 'live' && existing.type === 'video') ||
        (video.type === 'scheduled' && existing.type === 'video');
      
      if (shouldReplace) {
        seen.set(video.videoId, video);
      }
    }
    
    return Array.from(seen.values());
  }

  /**
   * Decodifica entidades HTML
   */
  private decodeHtmlEntities(text: string): string {
    return text
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#x27;/g, "'")
      .replace(/&#x2F;/g, '/');
  }
}

/**
 * Instância padrão do scraper
 */
export const scraper = new YouTubeScraper();

