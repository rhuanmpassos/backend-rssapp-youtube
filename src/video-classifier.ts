import { VideoType, YTPlayerResponse } from './types';
import { HttpClient, httpClient } from './http-client';

/**
 * Threshold de duração para shorts (em segundos)
 */
const SHORTS_MAX_DURATION = 90;

/**
 * Padrões para extrair dados do ytInitialPlayerResponse
 */
const PATTERNS = {
  // isLive: está ao vivo agora
  isLive: [
    /"isLive"\s*:\s*true/,
    /"isLiveNow"\s*:\s*true/,
  ],
  
  // isUpcoming: live programada
  isUpcoming: [
    /"isUpcoming"\s*:\s*true/,
  ],
  
  // isLiveContent: foi uma live (VOD)
  isLiveContent: [
    /"isLiveContent"\s*:\s*true/,
  ],
  
  // scheduledStartTime: quando a live vai começar
  scheduledStartTime: [
    /"scheduledStartTime"\s*:\s*"(\d+)"/,
    /"startTimestamp"\s*:\s*"([^"]+)"/,
  ],
  
  // duration: duração do vídeo
  duration: [
    /"lengthSeconds"\s*:\s*"(\d+)"/,
    /"approxDurationMs"\s*:\s*"(\d+)"/,
  ],
};

/**
 * Classifica o tipo de vídeo baseado nas propriedades
 */
export function classifyVideo(props: YTPlayerResponse, feedHint?: 'shorts' | 'lives'): VideoType {
  const { isLive, isLiveContent, isUpcoming, scheduledStartTime, duration } = props;

  // 1. Live programada
  if (isUpcoming && scheduledStartTime) {
    return 'scheduled';
  }

  // 2. Live ao vivo agora
  if (isLive) {
    return 'live';
  }

  // 3. VOD (gravação de live)
  if (isLiveContent) {
    return 'vod';
  }

  // 4. Short (duração <= 90s)
  if (duration !== undefined && duration <= SHORTS_MAX_DURATION) {
    return 'short';
  }

  // 5. Se veio do feed de shorts, é short
  if (feedHint === 'shorts') {
    return 'short';
  }

  // 6. Vídeo regular
  return 'video';
}

/**
 * Extrai dados do player response do HTML
 */
export function extractPlayerResponse(html: string): YTPlayerResponse {
  const result: YTPlayerResponse = {};

  // Verifica isLive
  for (const pattern of PATTERNS.isLive) {
    if (pattern.test(html)) {
      result.isLive = true;
      break;
    }
  }

  // Verifica isUpcoming
  for (const pattern of PATTERNS.isUpcoming) {
    if (pattern.test(html)) {
      result.isUpcoming = true;
      break;
    }
  }

  // Verifica isLiveContent
  for (const pattern of PATTERNS.isLiveContent) {
    if (pattern.test(html)) {
      result.isLiveContent = true;
      break;
    }
  }

  // Extrai scheduledStartTime
  for (const pattern of PATTERNS.scheduledStartTime) {
    const match = html.match(pattern);
    if (match && match[1]) {
      const timestamp = match[1];
      // Se é um número, é unix timestamp em segundos
      if (/^\d+$/.test(timestamp)) {
        result.scheduledStartTime = new Date(parseInt(timestamp) * 1000);
      } else {
        result.scheduledStartTime = new Date(timestamp);
      }
      break;
    }
  }

  // Extrai duration
  for (const pattern of PATTERNS.duration) {
    const match = html.match(pattern);
    if (match && match[1]) {
      const value = parseInt(match[1]);
      // approxDurationMs está em milissegundos
      if (pattern.source.includes('approxDurationMs')) {
        result.duration = Math.floor(value / 1000);
      } else {
        result.duration = value;
      }
      break;
    }
  }

  return result;
}

/**
 * Busca detalhes de classificação de um vídeo
 */
export async function getVideoClassification(
  videoId: string,
  feedHint?: 'shorts' | 'lives',
  client: HttpClient = httpClient
): Promise<{ type: VideoType; props: YTPlayerResponse }> {
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  
  try {
    const html = await client.get(url);
    const props = extractPlayerResponse(html);
    const type = classifyVideo(props, feedHint);
    
    return { type, props };
  } catch (error) {
    console.error(`Erro ao classificar vídeo ${videoId}:`, error);
    
    // Fallback baseado no hint
    return {
      type: feedHint === 'shorts' ? 'short' : feedHint === 'lives' ? 'vod' : 'video',
      props: {},
    };
  }
}

/**
 * Classifica múltiplos vídeos em batch
 */
export async function classifyVideos(
  videoIds: string[],
  feedHints?: Map<string, 'shorts' | 'lives'>,
  client: HttpClient = httpClient
): Promise<Map<string, { type: VideoType; props: YTPlayerResponse }>> {
  const results = new Map<string, { type: VideoType; props: YTPlayerResponse }>();

  await Promise.all(
    videoIds.map(async videoId => {
      const hint = feedHints?.get(videoId);
      const classification = await getVideoClassification(videoId, hint, client);
      results.set(videoId, classification);
    })
  );

  return results;
}

/**
 * Verifica se um vídeo está ao vivo agora
 */
export async function isVideoLive(
  videoId: string,
  client: HttpClient = httpClient
): Promise<boolean> {
  const { props } = await getVideoClassification(videoId, undefined, client);
  return props.isLive === true;
}

/**
 * Verifica se um vídeo é uma live programada
 */
export async function isVideoScheduled(
  videoId: string,
  client: HttpClient = httpClient
): Promise<{ scheduled: boolean; startTime?: Date }> {
  const { props } = await getVideoClassification(videoId, undefined, client);
  
  return {
    scheduled: props.isUpcoming === true,
    startTime: props.scheduledStartTime,
  };
}

