import { EventEmitter } from 'events';
import { YouTubeScraper } from '../youtube-scraper';
import { DatabaseService, getDatabase } from '../db/database';
import { VideoInfo, ChannelInfo } from '../types';
import { DBEvent, EventType } from '../db/schema';

/**
 * Configurações do monitor
 */
export interface MonitorConfig {
  /** Intervalo de polling em ms (padrão: 3 minutos) */
  pollingInterval?: number;
  /** Classificar vídeos individualmente (mais lento, mais preciso) */
  classifyVideos?: boolean;
  /** Máximo de vídeos por feed */
  maxVideosPerFeed?: number;
  /** Connection string do banco de dados PostgreSQL */
  databaseUrl?: string;
  /** Máximo de vídeos salvos por canal no DB (padrão: 10) */
  maxVideosPerChannel?: number;
  /** Dias para manter eventos/logs no DB (padrão: 3) */
  maxEventDays?: number;
}

const DEFAULT_CONFIG: Required<MonitorConfig> = {
  pollingInterval: 3 * 60 * 1000, // 3 minutos
  classifyVideos: false, // Desabilitado - YouTube bloqueia IPs do Render
  maxVideosPerFeed: 15,
  databaseUrl: process.env.DATABASE_URL || '',
  maxVideosPerChannel: 10, // Mantém apenas 10 vídeos por canal no DB
  maxEventDays: 3, // Mantém eventos dos últimos 3 dias
};

/**
 * Eventos emitidos pelo monitor
 */
export interface MonitorEvents {
  'new_video': (video: VideoInfo, channel: ChannelInfo) => void;
  'live_started': (video: VideoInfo, channel: ChannelInfo) => void;
  'live_ended': (video: VideoInfo, channel: ChannelInfo) => void;
  'scheduled_live': (video: VideoInfo, channel: ChannelInfo) => void;
  'video_updated': (video: VideoInfo, channel: ChannelInfo) => void;
  'error': (error: Error, channelId?: string) => void;
  'channel_checked': (channelId: string, videosCount: number) => void;
  'cycle_complete': (stats: { channels: number; videos: number; events: number }) => void;
}

/**
 * Serviço de monitoramento de canais do YouTube
 */
export class YouTubeMonitor extends EventEmitter {
  private config: Required<MonitorConfig>;
  private scraper: YouTubeScraper;
  private db: DatabaseService | null = null;
  private pollingTimer: NodeJS.Timeout | null = null;
  private isRunning = false;
  private channelCache: Map<string, ChannelInfo> = new Map();
  private initialized = false;

  constructor(config: MonitorConfig = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.scraper = new YouTubeScraper({
      minDelay: 200,
      maxDelay: 800,
      maxConcurrent: 2,
    });
  }

  /**
   * Inicializa a conexão com o banco de dados
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    
    this.db = await getDatabase(this.config.databaseUrl);
    this.initialized = true;
  }

  /**
   * Obtém o banco de dados (garante inicialização)
   */
  private async ensureDb(): Promise<DatabaseService> {
    if (!this.db) {
      await this.initialize();
    }
    return this.db!;
  }

  /**
   * Adiciona um canal para monitorar
   */
  async addChannel(urlOrHandle: string): Promise<ChannelInfo | null> {
    try {
      const db = await this.ensureDb();
      const channelInfo = await this.scraper.getChannelInfo(urlOrHandle);
      
      if (!channelInfo) {
        console.error(`Canal não encontrado: ${urlOrHandle}`);
        return null;
      }

      // Salva no banco
      await db.upsertChannel(channelInfo);
      this.channelCache.set(channelInfo.channelId, channelInfo);
      
      console.log(`✅ Canal adicionado: ${channelInfo.title} (${channelInfo.channelId})`);
      
      // Faz a primeira busca de vídeos
      await this.checkChannel(channelInfo.channelId);
      
      return channelInfo;
    } catch (error) {
      console.error(`Erro ao adicionar canal ${urlOrHandle}:`, error);
      this.emit('error', error as Error);
      return null;
    }
  }

  /**
   * Remove um canal do monitoramento
   */
  async removeChannel(channelId: string): Promise<void> {
    const db = await this.ensureDb();
    await db.deactivateChannel(channelId);
    this.channelCache.delete(channelId);
    console.log(`🗑️ Canal removido: ${channelId}`);
  }

  /**
   * Verifica um canal específico
   */
  async checkChannel(channelId: string): Promise<VideoInfo[]> {
    try {
      const db = await this.ensureDb();
      
      // Verifica se o canal ainda existe no banco (pode ter sido deletado)
      const channel = await db.getChannel(channelId);
      if (!channel) {
        // Canal foi deletado, limpa do cache e ignora
        this.channelCache.delete(channelId);
        return [];
      }
      
      // Busca vídeos do canal SEM classificação individual
      // A classificação de lives é feita separadamente (menos requests)
      const videos = await this.scraper.getChannelVideos(channelId, {
        classifyVideos: false, // Desabilitado - YouTube bloqueia IPs do Render
        maxVideosPerFeed: this.config.maxVideosPerFeed,
        includeVideos: true,
        includeLives: true,
        includeShorts: true, // Habilitado para identificar e filtrar shorts
      });

      // Obtém info do canal do cache ou banco
      let channelInfo = this.channelCache.get(channelId);
      if (!channelInfo) {
        const dbChannel = await db.getChannel(channelId);
        if (dbChannel) {
          channelInfo = {
            channelId: dbChannel.channel_id,
            title: dbChannel.title,
            description: dbChannel.description || undefined,
            thumbnailUrl: dbChannel.thumbnail_url || undefined,
          };
          this.channelCache.set(channelId, channelInfo);
        }
      }

      // Verifica status de lives ao vivo (apenas 1 request por canal)
      const liveNow = await this.scraper.checkLiveStatus(channelId);
      if (liveNow && channelInfo) {
        // Atualiza ou adiciona a live ao vivo
        const { event } = await db.upsertVideo(liveNow, channelId);
        if (event) {
          this.emit(event, liveNow, channelInfo);
        }
      }

      // Coleta IDs de shorts para filtrar (vídeos que aparecem no feed de shorts)
      const shortVideoIds = new Set(
        videos
          .filter(v => v.type === 'short')
          .map(v => v.videoId)
      );

      // Processa apenas vídeos normais (não VODs, não shorts)
      for (const video of videos) {
        // Filtro: ignora shorts por tipo
        if (video.type === 'short') {
          continue;
        }
        
        // Filtro: ignora shorts por duração (< 2 min)
        if (video.duration && video.duration < 120) {
          continue;
        }
        
        // Filtro: ignora shorts identificados pelo feed UUSH
        if (shortVideoIds.has(video.videoId)) {
          continue;
        }
        
        // Filtro: ignora se tem #shorts no título
        if (video.title.toLowerCase().includes('#shorts')) {
          continue;
        }
        
        // Filtro: ignora VODs (gravações de lives passadas)
        if (video.type === 'vod' || video.isLiveContent) {
          continue;
        }
        
        // Filtro: ignora lives (já processadas acima)
        if (video.type === 'live' || video.isLive) {
          continue;
        }
        
        // Salva apenas vídeos normais
        if (video.type === 'video') {
          const { event } = await db.upsertVideo(video, channelId);
          
          // Emite evento se houver mudança
          if (event && channelInfo) {
            this.emit(event, video, channelInfo);
          }
        }
      }
      
      // Remove lives que terminaram (não estão mais ao vivo)
      // Passa a live atual para não ser removida
      await this.cleanupEndedLives(channelId, liveNow);

      // Atualiza timestamp de verificação
      await db.updateChannelLastChecked(channelId);
      
      this.emit('channel_checked', channelId, videos.length);
      
      return videos;
    } catch (error) {
      console.error(`Erro ao verificar canal ${channelId}:`, error);
      this.emit('error', error as Error, channelId);
      return [];
    }
  }

  /**
   * Verifica todos os canais ativos
   */
  async checkAllChannels(): Promise<void> {
    const db = await this.ensureDb();
    const channels = await db.getActiveChannels();
    let totalVideos = 0;
    let totalEvents = 0;

    console.log(`\n🔄 Verificando ${channels.length} canais...`);

    for (const channel of channels) {
      const videos = await this.checkChannel(channel.channel_id);
      totalVideos += videos.length;
    }

    // Conta eventos das últimas 24h
    const events = await db.getRecentEvents(100);
    totalEvents = events.length;

    // Executa limpeza automática do banco
    await db.runCleanup({
      maxVideosPerChannel: this.config.maxVideosPerChannel,
      maxEventDays: this.config.maxEventDays,
    });

    this.emit('cycle_complete', {
      channels: channels.length,
      videos: totalVideos,
      events: totalEvents,
    });

    console.log(`✅ Ciclo completo: ${channels.length} canais, ${totalVideos} vídeos`);
  }

  /**
   * Inicia o monitoramento
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      console.log('Monitor já está rodando');
      return;
    }

    await this.initialize();
    this.isRunning = true;
    console.log(`\n🚀 Monitor iniciado (intervalo: ${this.config.pollingInterval / 1000}s)`);

    // Faz a primeira verificação
    this.checkAllChannels();

    // Configura o polling
    this.pollingTimer = setInterval(() => {
      this.checkAllChannels();
    }, this.config.pollingInterval);
  }

  /**
   * Para o monitoramento
   */
  stop(): void {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;
    
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
    }

    console.log('🛑 Monitor parado');
  }

  /**
   * Obtém o status atual
   */
  async getStatus(): Promise<{
    isRunning: boolean;
    stats: Awaited<ReturnType<DatabaseService['getStats']>>;
    channels: ChannelInfo[];
  }> {
    const db = await this.ensureDb();
    const dbChannels = await db.getActiveChannels();
    const channels = dbChannels.map(ch => ({
      channelId: ch.channel_id,
      title: ch.title,
      description: ch.description || undefined,
      thumbnailUrl: ch.thumbnail_url || undefined,
    }));

    return {
      isRunning: this.isRunning,
      stats: await db.getStats(),
      channels,
    };
  }

  /**
   * Obtém vídeos ao vivo
   */
  async getLiveVideos(): Promise<VideoInfo[]> {
    const db = await this.ensureDb();
    const dbVideos = await db.getLiveVideos();
    return dbVideos.map(this.dbVideoToVideoInfo);
  }

  /**
   * Obtém lives programadas
   */
  async getScheduledLives(): Promise<VideoInfo[]> {
    const db = await this.ensureDb();
    const dbVideos = await db.getScheduledLives();
    return dbVideos.map(this.dbVideoToVideoInfo);
  }

  /**
   * Obtém eventos recentes
   */
  async getRecentEvents(limit = 50): Promise<DBEvent[]> {
    const db = await this.ensureDb();
    return db.getRecentEvents(limit);
  }

  /**
   * Obtém eventos desde um timestamp
   */
  async getEventsSince(since: Date): Promise<DBEvent[]> {
    const db = await this.ensureDb();
    return db.getEventsSince(since);
  }

  /**
   * Converte DBVideo para VideoInfo
   */
  private dbVideoToVideoInfo(dbVideo: any): VideoInfo {
    return {
      videoId: dbVideo.video_id,
      title: dbVideo.title,
      publishedAt: new Date(dbVideo.published_at),
      thumbnailUrl: dbVideo.thumbnail_url,
      type: dbVideo.type,
      duration: dbVideo.duration || undefined,
      scheduledStartTime: dbVideo.scheduled_start_time ? new Date(dbVideo.scheduled_start_time) : undefined,
      isLive: dbVideo.is_live === 1,
      isLiveContent: dbVideo.is_live_content === 1,
      isUpcoming: dbVideo.is_upcoming === 1,
    };
  }

  /**
   * Remove lives que terminaram (não estão mais ao vivo)
   */
  private async cleanupEndedLives(channelId: string, currentLive: VideoInfo | null): Promise<void> {
    const db = await this.ensureDb();
    
    // Busca lives salvas no banco para este canal
    const savedLives = await db.getLiveVideos(channelId);
    
    // Se não há live atual, remove todas as lives salvas deste canal
    // Se há live atual, mantém apenas ela
    for (const savedLive of savedLives) {
      // Se não há live atual OU se a live salva é diferente da atual
      if (!currentLive || savedLive.video_id !== currentLive.videoId) {
        await db.deleteVideo(savedLive.video_id);
        console.log(`🔴➡️⬛ Live terminada removida: ${savedLive.title}`);
      }
    }
  }

  /**
   * Acesso ao banco de dados
   */
  async getDatabase(): Promise<DatabaseService> {
    return this.ensureDb();
  }
}

/**
 * Cria uma nova instância do monitor
 */
export function createMonitor(config?: MonitorConfig): YouTubeMonitor {
  return new YouTubeMonitor(config);
}
