import { DatabaseService } from '../db/database';
import { DBVideo, DBChannel } from '../db/schema';

/**
 * Gera feeds RSS personalizados a partir dos dados no banco
 */
export class RSSGenerator {
  private db: DatabaseService;

  constructor(db: DatabaseService) {
    this.db = db;
  }

  /**
   * Gera feed RSS de um canal específico
   */
  async generateChannelFeed(channelId: string, options: {
    includeTypes?: ('video' | 'short' | 'live' | 'scheduled' | 'vod')[];
    maxItems?: number;
  } = {}): Promise<string> {
    const { includeTypes, maxItems = 50 } = options;
    
    const channel = await this.db.getChannel(channelId);
    if (!channel) {
      throw new Error(`Canal não encontrado: ${channelId}`);
    }

    let videos = await this.db.getChannelVideos(channelId, maxItems);
    
    // Filtra por tipo se especificado
    if (includeTypes && includeTypes.length > 0) {
      videos = videos.filter(v => includeTypes.includes(v.type));
    }

    return this.buildRSSXml(channel, videos);
  }

  /**
   * Gera feed RSS de lives ao vivo agora
   */
  async generateLiveNowFeed(): Promise<string> {
    const videos = await this.db.getLiveVideos();
    const channels = await this.db.getActiveChannels();
    
    const channelMap = new Map(channels.map(c => [c.channel_id, c]));
    
    return this.buildRSSXml(
      {
        channel_id: 'live-now',
        title: 'Lives Ao Vivo Agora',
        description: 'Todas as lives acontecendo agora nos canais monitorados',
        thumbnail_url: null,
      } as DBChannel,
      videos,
      channelMap
    );
  }

  /**
   * Gera feed RSS de lives programadas
   */
  async generateScheduledFeed(): Promise<string> {
    const videos = await this.db.getScheduledLives();
    const channels = await this.db.getActiveChannels();
    
    const channelMap = new Map(channels.map(c => [c.channel_id, c]));
    
    return this.buildRSSXml(
      {
        channel_id: 'scheduled',
        title: 'Lives Programadas',
        description: 'Todas as lives programadas nos canais monitorados',
        thumbnail_url: null,
      } as DBChannel,
      videos,
      channelMap
    );
  }

  /**
   * Gera feed RSS de todos os vídeos recentes
   */
  async generateAllRecentFeed(hours: number = 24): Promise<string> {
    const videos = await this.db.getRecentVideos(hours);
    const channels = await this.db.getActiveChannels();
    
    const channelMap = new Map(channels.map(c => [c.channel_id, c]));
    
    return this.buildRSSXml(
      {
        channel_id: 'all-recent',
        title: 'Vídeos Recentes',
        description: `Todos os vídeos das últimas ${hours} horas`,
        thumbnail_url: null,
      } as DBChannel,
      videos,
      channelMap
    );
  }

  /**
   * Gera feed RSS combinado de todos os canais
   */
  async generateCombinedFeed(options: {
    includeTypes?: ('video' | 'short' | 'live' | 'scheduled' | 'vod')[];
    maxItems?: number;
  } = {}): Promise<string> {
    const { includeTypes, maxItems = 100 } = options;
    
    const channels = await this.db.getActiveChannels();
    const channelMap = new Map(channels.map(c => [c.channel_id, c]));
    
    let allVideos: DBVideo[] = [];
    
    for (const channel of channels) {
      const videos = await this.db.getChannelVideos(channel.channel_id, 20);
      allVideos.push(...videos);
    }

    // Filtra por tipo se especificado
    if (includeTypes && includeTypes.length > 0) {
      allVideos = allVideos.filter(v => includeTypes.includes(v.type));
    }

    // Ordena por data e limita
    allVideos.sort((a, b) => 
      new Date(b.published_at).getTime() - new Date(a.published_at).getTime()
    );
    allVideos = allVideos.slice(0, maxItems);

    return this.buildRSSXml(
      {
        channel_id: 'combined',
        title: 'Feed Combinado',
        description: 'Todos os vídeos de todos os canais monitorados',
        thumbnail_url: null,
      } as DBChannel,
      allVideos,
      channelMap
    );
  }

  /**
   * Constrói o XML do feed RSS
   */
  private buildRSSXml(
    channel: DBChannel | { channel_id: string; title: string; description: string | null; thumbnail_url: string | null },
    videos: DBVideo[],
    channelMap?: Map<string, DBChannel>
  ): string {
    const now = new Date().toUTCString();
    const channelLink = channel.channel_id.startsWith('UC') 
      ? `https://www.youtube.com/channel/${channel.channel_id}`
      : `https://youtube-monitor.local/${channel.channel_id}`;

    let xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/" xmlns:yt="http://www.youtube.com/xml/schemas/2015">
  <channel>
    <title>${this.escapeXml(channel.title)}</title>
    <link>${channelLink}</link>
    <description>${this.escapeXml(channel.description || '')}</description>
    <pubDate>${now}</pubDate>
    <lastBuildDate>${now}</lastBuildDate>
    <generator>YouTube Monitor RSS Generator</generator>
`;

    if (channel.thumbnail_url) {
      xml += `    <image>
      <url>${channel.thumbnail_url}</url>
      <title>${this.escapeXml(channel.title)}</title>
      <link>${channelLink}</link>
    </image>
`;
    }

    for (const video of videos) {
      const videoChannel = channelMap?.get(video.channel_id);
      const videoChannelTitle = videoChannel?.title || video.channel_id;
      
      xml += this.buildItemXml(video, videoChannelTitle);
    }

    xml += `  </channel>
</rss>`;

    return xml;
  }

  /**
   * Constrói XML de um item do feed
   */
  private buildItemXml(video: DBVideo, channelTitle: string): string {
    const videoUrl = `https://www.youtube.com/watch?v=${video.video_id}`;
    const pubDate = new Date(video.published_at).toUTCString();
    
    // Determina o badge/emoji baseado no tipo
    let typeBadge = '';
    switch (video.type) {
      case 'live': typeBadge = '🔴 LIVE: '; break;
      case 'scheduled': typeBadge = '📅 PROGRAMADO: '; break;
      case 'vod': typeBadge = '🎬 VOD: '; break;
      case 'short': typeBadge = '📱 SHORT: '; break;
    }

    let description = `<![CDATA[
      <p><strong>Canal:</strong> ${this.escapeXml(channelTitle)}</p>
      <p><strong>Tipo:</strong> ${video.type}</p>
`;

    if (video.duration) {
      description += `      <p><strong>Duração:</strong> ${this.formatDuration(video.duration)}</p>\n`;
    }

    if (video.scheduled_start_time) {
      description += `      <p><strong>Início programado:</strong> ${new Date(video.scheduled_start_time).toLocaleString('pt-BR')}</p>\n`;
    }

    if (video.is_live) {
      description += `      <p style="color: red;"><strong>🔴 AO VIVO AGORA</strong></p>\n`;
    }

    description += `      <p><img src="${video.thumbnail_url}" alt="${this.escapeXml(video.title)}" style="max-width: 100%;"/></p>
    ]]>`;

    return `    <item>
      <title>${typeBadge}${this.escapeXml(video.title)}</title>
      <link>${videoUrl}</link>
      <guid isPermaLink="true">${videoUrl}</guid>
      <pubDate>${pubDate}</pubDate>
      <author>${this.escapeXml(channelTitle)}</author>
      <description>${description}</description>
      <media:thumbnail url="${video.thumbnail_url}" />
      <yt:videoId>${video.video_id}</yt:videoId>
      <yt:channelId>${video.channel_id}</yt:channelId>
      <category>${video.type}</category>
    </item>
`;
  }

  /**
   * Escapa caracteres especiais para XML
   */
  private escapeXml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Formata duração em segundos para HH:MM:SS
   */
  private formatDuration(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    if (hours > 0) {
      return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${minutes}:${secs.toString().padStart(2, '0')}`;
  }
}
