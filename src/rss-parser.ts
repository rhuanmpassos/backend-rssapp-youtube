import { XMLParser } from 'fast-xml-parser';
import { RSSItem, FeedType } from './types';
import { HttpClient, httpClient } from './http-client';

/**
 * URLs base dos feeds RSS do YouTube
 */
const FEED_URLS = {
  // Feed padrão de vídeos (UULF = uploads)
  videos: (channelId: string) => 
    `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`,
  
  // Feed de lives/VODs (UULV)
  lives: (channelId: string) => {
    const playlistId = channelId.replace(/^UC/, 'UULV');
    return `https://www.youtube.com/feeds/videos.xml?playlist_id=${playlistId}`;
  },
  
  // Feed de shorts (UUSH)
  shorts: (channelId: string) => {
    const playlistId = channelId.replace(/^UC/, 'UUSH');
    return `https://www.youtube.com/feeds/videos.xml?playlist_id=${playlistId}`;
  },
};

/**
 * Parser XML configurado
 */
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  parseAttributeValue: true,
});

/**
 * Faz parse do feed RSS do YouTube
 */
export async function parseRSSFeed(
  channelId: string,
  feedType: FeedType = 'videos',
  client: HttpClient = httpClient
): Promise<RSSItem[]> {
  const feedUrl = FEED_URLS[feedType](channelId);
  
  try {
    const xml = await client.get(feedUrl);
    return parseRSSXml(xml);
  } catch (error) {
    const err = error as Error & { status?: number };
    // Feeds de lives/shorts podem não existir - é normal
    if (feedType !== 'videos') {
      // 404 é esperado - canal simplesmente não tem shorts/lives
      if (err.status === 404) {
        // Log silencioso - é completamente normal
        return [];
      }
      // Outros erros merecem atenção
      console.warn(`⚠️ Erro ao buscar feed ${feedType} para ${channelId}: ${err.message}`);
      return [];
    }
    throw error;
  }
}

/**
 * Faz parse do XML do RSS
 */
export function parseRSSXml(xml: string): RSSItem[] {
  const result = xmlParser.parse(xml);
  
  if (!result.feed || !result.feed.entry) {
    return [];
  }
  
  const entries = Array.isArray(result.feed.entry) 
    ? result.feed.entry 
    : [result.feed.entry];
  
  return entries.map(parseRSSEntry).filter(Boolean) as RSSItem[];
}

/**
 * Faz parse de uma entrada do RSS
 */
function parseRSSEntry(entry: any): RSSItem | null {
  try {
    // Extrai videoId da URL
    const videoUrl = entry.link?.['@_href'] || '';
    const videoIdMatch = videoUrl.match(/watch\?v=([a-zA-Z0-9_-]{11})/);
    const videoId = videoIdMatch?.[1] || entry['yt:videoId'];
    
    if (!videoId) {
      return null;
    }

    // Extrai thumbnail
    const thumbnailGroup = entry['media:group'];
    const thumbnailUrl = thumbnailGroup?.['media:thumbnail']?.['@_url'] 
      || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
    
    // Extrai view count
    const viewCount = thumbnailGroup?.['media:community']?.['media:statistics']?.['@_views'];

    return {
      videoId,
      title: entry.title || '',
      publishedAt: new Date(entry.published),
      updatedAt: new Date(entry.updated),
      thumbnailUrl,
      description: thumbnailGroup?.['media:description'],
      viewCount: viewCount ? parseInt(viewCount) : undefined,
    };
  } catch (error) {
    console.error('Erro ao fazer parse de entrada RSS:', error);
    return null;
  }
}

/**
 * Busca todos os vídeos de um canal de todos os feeds
 */
export async function getAllChannelVideos(
  channelId: string,
  options: {
    includeVideos?: boolean;
    includeShorts?: boolean;
    includeLives?: boolean;
  } = {},
  client: HttpClient = httpClient
): Promise<Map<FeedType, RSSItem[]>> {
  const {
    includeVideos = true,
    includeShorts = true,
    includeLives = true,
  } = options;

  const feedsToFetch: FeedType[] = [];
  
  // IMPORTANTE: Lives primeiro para que VODs sejam identificados corretamente
  // na deduplicação (o primeiro item é mantido)
  if (includeLives) feedsToFetch.push('lives');
  if (includeVideos) feedsToFetch.push('videos');
  if (includeShorts) feedsToFetch.push('shorts');

  const results = new Map<FeedType, RSSItem[]>();

  await Promise.all(
    feedsToFetch.map(async feedType => {
      try {
        const items = await parseRSSFeed(channelId, feedType, client);
        results.set(feedType, items);
      } catch (error) {
        console.error(`Erro ao buscar feed ${feedType}:`, error);
        results.set(feedType, []);
      }
    })
  );

  return results;
}

/**
 * Gera URL do feed RSS
 */
export function getFeedUrl(channelId: string, feedType: FeedType): string {
  return FEED_URLS[feedType](channelId);
}

