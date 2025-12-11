import { Pool, PoolClient } from 'pg';
import { 
  CREATE_TABLES_SQL, 
  DBChannel, 
  DBVideo, 
  DBRSSFeed, 
  DBEvent, 
  EventType 
} from './schema';
import { VideoInfo, ChannelInfo } from '../types';

/**
 * Classe de gerenciamento do banco de dados PostgreSQL
 */
export class DatabaseService {
  private pool: Pool;

  constructor(connectionString?: string) {
    const dbUrl = connectionString || process.env.DATABASE_URL;
    
    if (!dbUrl) {
      throw new Error('DATABASE_URL não configurada');
    }

    // Detecta se precisa de SSL baseado na URL
    const needsSSL = dbUrl.includes('neon.tech') || 
                     dbUrl.includes('render.com') || 
                     dbUrl.includes('sslmode=require');

    this.pool = new Pool({
      connectionString: dbUrl,
      ssl: needsSSL ? { rejectUnauthorized: false } : false
    });
  }

  /**
   * Inicializa o banco de dados com as tabelas
   * Verifica se as tabelas já existem antes de criar para evitar erros de permissão
   */
  async initialize(): Promise<void> {
    const client = await this.pool.connect();
    try {
      // Verifica se as tabelas principais já existem
      const tablesExist = await this.checkTablesExist(client);
      
      if (!tablesExist) {
        // Só executa o schema se as tabelas não existem
        await client.query(CREATE_TABLES_SQL);
        console.log('📦 Tabelas criadas com sucesso');
      } else {
        console.log('📦 Tabelas já existem, pulando criação');
      }
      
      await this.runMigrations(client);
    } finally {
      client.release();
    }
  }

  /**
   * Verifica se as tabelas principais já existem no banco
   */
  private async checkTablesExist(client: PoolClient): Promise<boolean> {
    try {
      const result = await client.query(`
        SELECT COUNT(*) as count FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name IN ('channels', 'videos', 'events', 'rss_feeds')
      `);
      return parseInt(result.rows[0].count) >= 4;
    } catch {
      return false;
    }
  }

  /**
   * Executa migrations para atualizar banco existente
   * Silenciosamente ignora erros de permissão (owner)
   */
  private async runMigrations(client: PoolClient): Promise<void> {
    try {
      // Verifica se coluna bookmarked existe
      const result = await client.query(`
        SELECT column_name FROM information_schema.columns 
        WHERE table_name = 'videos' AND column_name = 'bookmarked'
      `);
      
      if (result.rows.length === 0) {
        try {
          await client.query('ALTER TABLE videos ADD COLUMN bookmarked INTEGER DEFAULT 0');
          console.log('📦 Migration: Coluna "bookmarked" adicionada à tabela videos');
        } catch (alterError: any) {
          // Erro 42501 = permissão insuficiente (não é owner)
          if (alterError?.code === '42501') {
            console.log('⚠️ Migration: Sem permissão para alterar tabela (não é owner). Coluna bookmarked pode não existir.');
          } else {
            throw alterError;
          }
        }
      }
    } catch (error: any) {
      // Ignora erros de migration que não são críticos
      if (error?.code !== '42501') {
        console.warn('⚠️ Migration warning:', error?.message || error);
      }
    }
  }

  /**
   * Fecha a conexão com o banco
   */
  async close(): Promise<void> {
    await this.pool.end();
  }

  // ============================================
  // CANAIS
  // ============================================

  /**
   * Adiciona ou atualiza um canal
   */
  async upsertChannel(channel: ChannelInfo): Promise<DBChannel> {
    const result = await this.pool.query(`
      INSERT INTO channels (channel_id, title, description, thumbnail_url, updated_at)
      VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
      ON CONFLICT(channel_id) DO UPDATE SET
        title = EXCLUDED.title,
        description = EXCLUDED.description,
        thumbnail_url = EXCLUDED.thumbnail_url,
        updated_at = CURRENT_TIMESTAMP
      RETURNING *
    `, [channel.channelId, channel.title, channel.description || null, channel.thumbnailUrl || null]);

    return result.rows[0] as DBChannel;
  }

  /**
   * Obtém um canal pelo ID
   */
  async getChannel(channelId: string): Promise<DBChannel | undefined> {
    const result = await this.pool.query('SELECT * FROM channels WHERE channel_id = $1', [channelId]);
    return result.rows[0] as DBChannel | undefined;
  }

  /**
   * Lista todos os canais ativos
   */
  async getActiveChannels(): Promise<DBChannel[]> {
    const result = await this.pool.query('SELECT * FROM channels WHERE is_active = 1');
    return result.rows as DBChannel[];
  }

  /**
   * Atualiza timestamp de última verificação
   */
  async updateChannelLastChecked(channelId: string): Promise<void> {
    await this.pool.query(`
      UPDATE channels SET last_checked_at = CURRENT_TIMESTAMP WHERE channel_id = $1
    `, [channelId]);
  }

  /**
   * Remove um canal (soft delete)
   */
  async deactivateChannel(channelId: string): Promise<void> {
    await this.pool.query('UPDATE channels SET is_active = 0 WHERE channel_id = $1', [channelId]);
  }

  /**
   * Deleta um canal completamente (hard delete)
   * Remove também todos os vídeos, eventos e feeds associados
   */
  async deleteChannel(channelId: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      
      // 1. Deletar eventos do canal
      await client.query('DELETE FROM events WHERE channel_id = $1', [channelId]);
      
      // 2. Deletar feed RSS do canal
      await client.query('DELETE FROM rss_feeds WHERE channel_id = $1', [channelId]);
      
      // 3. Deletar vídeos do canal
      await client.query('DELETE FROM videos WHERE channel_id = $1', [channelId]);
      
      // 4. Deletar o canal
      const result = await client.query('DELETE FROM channels WHERE channel_id = $1', [channelId]);
      
      await client.query('COMMIT');
      
      return (result.rowCount ?? 0) > 0;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // ============================================
  // VÍDEOS
  // ============================================

  /**
   * Adiciona ou atualiza um vídeo
   * Retorna o tipo de evento que ocorreu (new_video, live_started, etc.)
   */
  async upsertVideo(video: VideoInfo, channelId: string): Promise<{ video: DBVideo; event: EventType | null }> {
    // Primeiro, busca o vídeo existente para comparar
    const existing = await this.getVideo(video.videoId);

    const result = await this.pool.query(`
      INSERT INTO videos (
        video_id, channel_id, title, thumbnail_url, published_at,
        type, duration, scheduled_start_time, is_live, is_live_content, is_upcoming, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, CURRENT_TIMESTAMP)
      ON CONFLICT(video_id) DO UPDATE SET
        title = EXCLUDED.title,
        thumbnail_url = EXCLUDED.thumbnail_url,
        type = EXCLUDED.type,
        duration = EXCLUDED.duration,
        scheduled_start_time = EXCLUDED.scheduled_start_time,
        is_live = EXCLUDED.is_live,
        is_live_content = EXCLUDED.is_live_content,
        is_upcoming = EXCLUDED.is_upcoming,
        updated_at = CURRENT_TIMESTAMP
      RETURNING *
    `, [
      video.videoId,
      channelId,
      video.title,
      video.thumbnailUrl,
      video.publishedAt.toISOString(),
      video.type,
      video.duration || null,
      video.scheduledStartTime?.toISOString() || null,
      video.isLive ? 1 : 0,
      video.isLiveContent ? 1 : 0,
      video.isUpcoming ? 1 : 0,
    ]);

    const dbVideo = result.rows[0] as DBVideo;

    // Determina o tipo de evento
    let event: EventType | null = null;

    if (!existing) {
      // Novo vídeo
      if (video.isLive) {
        event = 'live_started';
      } else if (video.isUpcoming) {
        event = 'scheduled_live';
      } else {
        event = 'new_video';
      }
    } else {
      // Vídeo existente - verifica mudanças
      if (!existing.is_live && video.isLive) {
        event = 'live_started';
      } else if (existing.is_live && !video.isLive) {
        event = 'live_ended';
      } else if (existing.type !== video.type || existing.title !== video.title) {
        event = 'video_updated';
      }
    }

    // Registra evento se houver
    if (event) {
      await this.addEvent(event, video.videoId, channelId, { 
        previousType: existing?.type,
        newType: video.type,
        wasLive: existing?.is_live === 1,
        isLive: video.isLive,
      });
    }

    return { video: dbVideo, event };
  }

  /**
   * Obtém um vídeo pelo ID
   */
  async getVideo(videoId: string): Promise<DBVideo | undefined> {
    const result = await this.pool.query('SELECT * FROM videos WHERE video_id = $1', [videoId]);
    return result.rows[0] as DBVideo | undefined;
  }

  /**
   * Deleta um vídeo pelo ID (e seus eventos associados)
   */
  async deleteVideo(videoId: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      
      // Deleta eventos do vídeo primeiro
      await client.query('DELETE FROM events WHERE video_id = $1', [videoId]);
      
      // Deleta o vídeo
      const result = await client.query('DELETE FROM videos WHERE video_id = $1', [videoId]);
      
      await client.query('COMMIT');
      return (result.rowCount ?? 0) > 0;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Lista vídeos de um canal
   */
  async getChannelVideos(channelId: string, limit: number = 50): Promise<DBVideo[]> {
    const result = await this.pool.query(`
      SELECT * FROM videos 
      WHERE channel_id = $1 
      ORDER BY published_at DESC 
      LIMIT $2
    `, [channelId, limit]);
    return result.rows as DBVideo[];
  }

  /**
   * Lista vídeos ao vivo agora
   */
  async getLiveVideos(channelId?: string): Promise<DBVideo[]> {
    if (channelId) {
      const result = await this.pool.query(`
        SELECT * FROM videos WHERE is_live = 1 AND channel_id = $1
      `, [channelId]);
      return result.rows as DBVideo[];
    }
    
    const result = await this.pool.query('SELECT * FROM videos WHERE is_live = 1');
    return result.rows as DBVideo[];
  }

  /**
   * Lista lives programadas
   */
  async getScheduledLives(channelId?: string): Promise<DBVideo[]> {
    if (channelId) {
      const result = await this.pool.query(`
        SELECT * FROM videos 
        WHERE is_upcoming = 1 AND channel_id = $1
        ORDER BY scheduled_start_time ASC
      `, [channelId]);
      return result.rows as DBVideo[];
    }
    
    const result = await this.pool.query(`
      SELECT * FROM videos WHERE is_upcoming = 1 ORDER BY scheduled_start_time ASC
    `);
    return result.rows as DBVideo[];
  }

  /**
   * Lista lives ao vivo + programadas (para o feed de lives do app)
   */
  async getLivesAndScheduled(channelId?: string): Promise<DBVideo[]> {
    if (channelId) {
      const result = await this.pool.query(`
        SELECT v.*, c.title as channel_title, c.thumbnail_url as channel_thumbnail
        FROM videos v
        JOIN channels c ON v.channel_id = c.channel_id
        WHERE (v.is_live = 1 OR v.is_upcoming = 1) AND v.channel_id = $1
        ORDER BY v.is_live DESC, v.scheduled_start_time ASC
      `, [channelId]);
      return result.rows as DBVideo[];
    }
    
    const result = await this.pool.query(`
      SELECT v.*, c.title as channel_title, c.thumbnail_url as channel_thumbnail
      FROM videos v
      JOIN channels c ON v.channel_id = c.channel_id
      WHERE v.is_live = 1 OR v.is_upcoming = 1
      ORDER BY v.is_live DESC, v.scheduled_start_time ASC
    `);
    return result.rows as DBVideo[];
  }

  /**
   * Lista vídeos regulares recentes (sem shorts, vods, lives)
   * Para o feed "tudo" do app
   * Filtra vídeos com menos de 2 minutos (provavelmente shorts)
   */
  async getRecentRegularVideos(hours: number = 24, limit: number = 100): Promise<DBVideo[]> {
    const result = await this.pool.query(`
      SELECT v.*, c.title as channel_title, c.thumbnail_url as channel_thumbnail
      FROM videos v
      JOIN channels c ON v.channel_id = c.channel_id
      WHERE v.type = 'video'
        AND (v.duration IS NULL OR v.duration >= 120)
        AND v.published_at >= NOW() - INTERVAL '1 hour' * $1
      ORDER BY v.published_at DESC
      LIMIT $2
    `, [hours, limit]);
    return result.rows as DBVideo[];
  }

  /**
   * Lista vídeos recentes (últimas 24h)
   */
  async getRecentVideos(hours: number = 24): Promise<DBVideo[]> {
    const result = await this.pool.query(`
      SELECT * FROM videos 
      WHERE created_at >= NOW() - INTERVAL '1 hour' * $1
      ORDER BY created_at DESC
    `, [hours]);
    return result.rows as DBVideo[];
  }

  // ============================================
  // BOOKMARKS
  // ============================================

  /**
   * Marca um vídeo como bookmark
   */
  async bookmarkVideo(videoId: string): Promise<boolean> {
    const result = await this.pool.query(`
      UPDATE videos SET bookmarked = 1, updated_at = CURRENT_TIMESTAMP 
      WHERE video_id = $1
    `, [videoId]);
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Remove bookmark de um vídeo
   */
  async unbookmarkVideo(videoId: string): Promise<boolean> {
    const result = await this.pool.query(`
      UPDATE videos SET bookmarked = 0, updated_at = CURRENT_TIMESTAMP 
      WHERE video_id = $1
    `, [videoId]);
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Lista vídeos com bookmark
   */
  async getBookmarkedVideos(): Promise<DBVideo[]> {
    const result = await this.pool.query(`
      SELECT v.*, c.title as channel_title, c.thumbnail_url as channel_thumbnail
      FROM videos v
      JOIN channels c ON v.channel_id = c.channel_id
      WHERE v.bookmarked = 1
      ORDER BY v.updated_at DESC
    `);
    return result.rows as DBVideo[];
  }

  /**
   * Verifica se um vídeo está com bookmark
   */
  async isBookmarked(videoId: string): Promise<boolean> {
    const result = await this.pool.query('SELECT bookmarked FROM videos WHERE video_id = $1', [videoId]);
    return result.rows[0]?.bookmarked === 1;
  }

  // ============================================
  // FEEDS RSS
  // ============================================

  /**
   * Salva o feed RSS gerado de um canal
   */
  async saveRSSFeed(channelId: string, feedXml: string): Promise<void> {
    await this.pool.query(`
      INSERT INTO rss_feeds (channel_id, feed_xml, generated_at)
      VALUES ($1, $2, CURRENT_TIMESTAMP)
      ON CONFLICT(channel_id) DO UPDATE SET
        feed_xml = EXCLUDED.feed_xml,
        generated_at = CURRENT_TIMESTAMP
    `, [channelId, feedXml]);
  }

  /**
   * Obtém o feed RSS de um canal
   */
  async getRSSFeed(channelId: string): Promise<DBRSSFeed | undefined> {
    const result = await this.pool.query('SELECT * FROM rss_feeds WHERE channel_id = $1', [channelId]);
    return result.rows[0] as DBRSSFeed | undefined;
  }

  // ============================================
  // EVENTOS
  // ============================================

  /**
   * Adiciona um evento
   */
  async addEvent(eventType: EventType, videoId: string, channelId: string, data?: any): Promise<DBEvent> {
    const result = await this.pool.query(`
      INSERT INTO events (event_type, video_id, channel_id, data)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `, [eventType, videoId, channelId, data ? JSON.stringify(data) : null]);
    return result.rows[0] as DBEvent;
  }

  /**
   * Lista eventos recentes
   */
  async getRecentEvents(limit: number = 100): Promise<DBEvent[]> {
    const result = await this.pool.query(`
      SELECT * FROM events ORDER BY created_at DESC LIMIT $1
    `, [limit]);
    return result.rows as DBEvent[];
  }

  /**
   * Lista eventos de um canal
   */
  async getChannelEvents(channelId: string, limit: number = 50): Promise<DBEvent[]> {
    const result = await this.pool.query(`
      SELECT * FROM events WHERE channel_id = $1 ORDER BY created_at DESC LIMIT $2
    `, [channelId, limit]);
    return result.rows as DBEvent[];
  }

  /**
   * Lista eventos desde um timestamp
   */
  async getEventsSince(since: Date): Promise<DBEvent[]> {
    const result = await this.pool.query(`
      SELECT * FROM events WHERE created_at > $1 ORDER BY created_at ASC
    `, [since.toISOString()]);
    return result.rows as DBEvent[];
  }

  // ============================================
  // ESTATÍSTICAS
  // ============================================

  // ============================================
  // CLEANUP / LIMPEZA
  // ============================================

  /**
   * Remove eventos mais antigos que X dias
   */
  async cleanupOldEvents(days: number = 3): Promise<number> {
    const result = await this.pool.query(`
      DELETE FROM events 
      WHERE created_at < NOW() - INTERVAL '1 day' * $1
    `, [days]);
    return result.rowCount ?? 0;
  }

  /**
   * Mantém apenas os N vídeos mais recentes por canal (preserva bookmarks)
   * Remove vídeos antigos que excedem o limite
   */
  async cleanupOldVideos(maxPerChannel: number = 10): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      
      // 1. Primeiro, deletar eventos dos vídeos que serão removidos
      await client.query(`
        DELETE FROM events
        WHERE video_id IN (
          SELECT video_id FROM (
            SELECT 
              video_id,
              ROW_NUMBER() OVER (PARTITION BY channel_id ORDER BY published_at DESC) as rn,
              bookmarked
            FROM videos
          ) ranked
          WHERE rn > $1 AND bookmarked = 0
        )
      `, [maxPerChannel]);
      
      // 2. Depois, deletar os vídeos
      const result = await client.query(`
        DELETE FROM videos
        WHERE id IN (
          SELECT id FROM (
            SELECT 
              id,
              ROW_NUMBER() OVER (PARTITION BY channel_id ORDER BY published_at DESC) as rn,
              bookmarked
            FROM videos
          ) ranked
          WHERE rn > $1 AND bookmarked = 0
        )
      `, [maxPerChannel]);
      
      await client.query('COMMIT');
      return result.rowCount ?? 0;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Remove eventos órfãos (de vídeos que foram deletados)
   */
  async cleanupOrphanEvents(): Promise<number> {
    const result = await this.pool.query(`
      DELETE FROM events 
      WHERE video_id NOT IN (SELECT video_id FROM videos)
    `);
    return result.rowCount ?? 0;
  }

  /**
   * Executa todas as rotinas de limpeza
   */
  async runCleanup(options: { maxVideosPerChannel?: number; maxEventDays?: number } = {}): Promise<{
    deletedVideos: number;
    deletedEvents: number;
    deletedOrphanEvents: number;
  }> {
    const maxVideos = options.maxVideosPerChannel ?? 10;
    const maxDays = options.maxEventDays ?? 3;

    const deletedVideos = await this.cleanupOldVideos(maxVideos);
    const deletedEvents = await this.cleanupOldEvents(maxDays);
    const deletedOrphanEvents = await this.cleanupOrphanEvents();

    if (deletedVideos > 0 || deletedEvents > 0 || deletedOrphanEvents > 0) {
      console.log(`🧹 Cleanup: ${deletedVideos} vídeos, ${deletedEvents} eventos, ${deletedOrphanEvents} eventos órfãos removidos`);
    }

    return { deletedVideos, deletedEvents, deletedOrphanEvents };
  }

  // ============================================
  // ESTATÍSTICAS
  // ============================================

  /**
   * Retorna estatísticas do banco
   */
  async getStats(): Promise<{
    totalChannels: number;
    activeChannels: number;
    totalVideos: number;
    liveNow: number;
    scheduledLives: number;
    recentEvents: number;
  }> {
    const [channels, activeChannels, videos, liveNow, scheduled, events] = await Promise.all([
      this.pool.query('SELECT COUNT(*) as count FROM channels'),
      this.pool.query('SELECT COUNT(*) as count FROM channels WHERE is_active = 1'),
      this.pool.query('SELECT COUNT(*) as count FROM videos'),
      this.pool.query('SELECT COUNT(*) as count FROM videos WHERE is_live = 1'),
      this.pool.query('SELECT COUNT(*) as count FROM videos WHERE is_upcoming = 1'),
      this.pool.query(`SELECT COUNT(*) as count FROM events WHERE created_at >= NOW() - INTERVAL '24 hours'`),
    ]);

    return {
      totalChannels: parseInt(channels.rows[0].count),
      activeChannels: parseInt(activeChannels.rows[0].count),
      totalVideos: parseInt(videos.rows[0].count),
      liveNow: parseInt(liveNow.rows[0].count),
      scheduledLives: parseInt(scheduled.rows[0].count),
      recentEvents: parseInt(events.rows[0].count),
    };
  }
}

/**
 * Instância padrão do banco de dados
 */
let defaultDb: DatabaseService | null = null;

export async function getDatabase(connectionString?: string): Promise<DatabaseService> {
  if (!defaultDb) {
    defaultDb = new DatabaseService(connectionString);
    await defaultDb.initialize();
  }
  return defaultDb;
}

export async function closeDatabase(): Promise<void> {
  if (defaultDb) {
    await defaultDb.close();
    defaultDb = null;
  }
}
