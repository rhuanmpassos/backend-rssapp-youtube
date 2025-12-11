import { ChannelInfo } from './types';
import { HttpClient, httpClient } from './http-client';

/**
 * Padrões regex para extrair Channel ID do HTML (por ordem de prioridade)
 */
const CHANNEL_ID_PATTERNS = [
  // 1. Meta tag canonical
  /<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[a-zA-Z0-9_-]{22})">/,
  // 2. itemprop channelId
  /<meta itemprop="channelId" content="(UC[a-zA-Z0-9_-]{22})">/,
  // 3. Dentro do JSON ytInitialData
  /"channelId":"(UC[a-zA-Z0-9_-]{22})"/,
  // 4. Dentro do JSON ytInitialPlayerResponse
  /"externalChannelId":"(UC[a-zA-Z0-9_-]{22})"/,
  // 5. URL no browseId
  /"browseId":"(UC[a-zA-Z0-9_-]{22})"/,
  // 6. RSS feed link
  /channel_id=(UC[a-zA-Z0-9_-]{22})/,
];

/**
 * Padrões para extrair título do canal
 */
const CHANNEL_TITLE_PATTERNS = [
  /<meta property="og:title" content="([^"]+)">/,
  /<meta name="title" content="([^"]+)">/,
  /"ownerChannelName":"([^"]+)"/,
  /<title>([^<]+) - YouTube<\/title>/,
];

/**
 * Padrões para extrair descrição do canal
 */
const CHANNEL_DESCRIPTION_PATTERNS = [
  /<meta property="og:description" content="([^"]+)">/,
  /<meta name="description" content="([^"]+)">/,
];

/**
 * Padrões para extrair thumbnail do canal
 */
const CHANNEL_THUMBNAIL_PATTERNS = [
  /<meta property="og:image" content="([^"]+)">/,
  /<link rel="image_src" href="([^"]+)">/,
];

/**
 * Extrai o Channel ID de uma URL ou handle
 */
export async function extractChannelId(
  urlOrHandle: string,
  client: HttpClient = httpClient
): Promise<string | null> {
  // Se já é um Channel ID
  if (/^UC[a-zA-Z0-9_-]{22}$/.test(urlOrHandle)) {
    return urlOrHandle;
  }

  // Normaliza para URL completa
  let url: string;
  
  if (urlOrHandle.startsWith('@')) {
    // Handle: @username
    url = `https://www.youtube.com/${urlOrHandle}`;
  } else if (urlOrHandle.startsWith('http')) {
    url = urlOrHandle;
  } else if (urlOrHandle.includes('/')) {
    url = `https://www.youtube.com/${urlOrHandle}`;
  } else {
    // Tenta como handle
    url = `https://www.youtube.com/@${urlOrHandle}`;
  }

  try {
    const html = await client.get(url);
    return extractChannelIdFromHtml(html);
  } catch (error) {
    console.error(`Erro ao extrair Channel ID de ${url}:`, error);
    return null;
  }
}

/**
 * Extrai Channel ID do HTML
 */
export function extractChannelIdFromHtml(html: string): string | null {
  for (const pattern of CHANNEL_ID_PATTERNS) {
    const match = html.match(pattern);
    if (match && match[1]) {
      return match[1];
    }
  }
  return null;
}

/**
 * Extrai informações completas do canal
 */
export async function getChannelInfo(
  urlOrHandle: string,
  client: HttpClient = httpClient
): Promise<ChannelInfo | null> {
  // Normaliza para URL completa
  let url: string;
  
  if (/^UC[a-zA-Z0-9_-]{22}$/.test(urlOrHandle)) {
    url = `https://www.youtube.com/channel/${urlOrHandle}`;
  } else if (urlOrHandle.startsWith('@')) {
    url = `https://www.youtube.com/${urlOrHandle}`;
  } else if (urlOrHandle.startsWith('http')) {
    url = urlOrHandle;
  } else if (urlOrHandle.includes('/')) {
    url = `https://www.youtube.com/${urlOrHandle}`;
  } else {
    url = `https://www.youtube.com/@${urlOrHandle}`;
  }

  try {
    const html = await client.get(url);
    return extractChannelInfoFromHtml(html);
  } catch (error) {
    console.error(`Erro ao obter info do canal de ${url}:`, error);
    return null;
  }
}

/**
 * Extrai informações do canal do HTML
 */
export function extractChannelInfoFromHtml(html: string): ChannelInfo | null {
  const channelId = extractChannelIdFromHtml(html);
  
  if (!channelId) {
    return null;
  }

  let title = '';
  let description: string | undefined;
  let thumbnailUrl: string | undefined;

  // Extrai título
  for (const pattern of CHANNEL_TITLE_PATTERNS) {
    const match = html.match(pattern);
    if (match && match[1]) {
      title = decodeHtmlEntities(match[1]);
      break;
    }
  }

  // Extrai descrição
  for (const pattern of CHANNEL_DESCRIPTION_PATTERNS) {
    const match = html.match(pattern);
    if (match && match[1]) {
      description = decodeHtmlEntities(match[1]);
      break;
    }
  }

  // Extrai thumbnail
  for (const pattern of CHANNEL_THUMBNAIL_PATTERNS) {
    const match = html.match(pattern);
    if (match && match[1]) {
      thumbnailUrl = match[1];
      break;
    }
  }

  return {
    channelId,
    title,
    description,
    thumbnailUrl,
  };
}

/**
 * Decodifica entidades HTML
 */
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&nbsp;/g, ' ');
}

