/**
 * YouTube Extractor
 * 
 * Scraper leve e rápido para YouTube usando apenas HTTP requests e HTML parsing
 */

// Exporta tipos
export * from './types';

// Exporta scraper principal
export { YouTubeScraper, scraper } from './youtube-scraper';

// Exporta módulos individuais
export { HttpClient, httpClient } from './http-client';
export { 
  extractChannelId, 
  getChannelInfo, 
  extractChannelIdFromHtml,
  extractChannelInfoFromHtml 
} from './channel-extractor';
export { 
  parseRSSFeed, 
  getAllChannelVideos, 
  getFeedUrl 
} from './rss-parser';
export { 
  classifyVideo, 
  extractPlayerResponse, 
  getVideoClassification,
  isVideoLive,
  isVideoScheduled 
} from './video-classifier';

