import http from 'http';
import { URL } from 'url';
import { YouTubeMonitor } from '../services/monitor';
import { RSSGenerator } from '../services/rss-generator';
import { VideoInfo, ChannelInfo } from '../types';
import { DatabaseService } from '../db/database';

/**
 * Configurações do servidor
 */
export interface ServerConfig {
  port?: number;
  host?: string;
}

/**
 * Servidor HTTP com SSE para o YouTube Monitor
 */
export class MonitorServer {
  private server: http.Server | null = null;
  private monitor: YouTubeMonitor;
  private rssGenerator: RSSGenerator | null = null;
  private sseClients: Set<http.ServerResponse> = new Set();
  private config: Required<ServerConfig>;

  constructor(monitor: YouTubeMonitor, config: ServerConfig = {}) {
    this.monitor = monitor;
    this.config = {
      port: config.port ?? 3000,
      host: config.host ?? '0.0.0.0',
    };

    this.setupEventListeners();
  }

  /**
   * Configura listeners de eventos do monitor
   */
  private setupEventListeners(): void {
    const events: Array<keyof import('../services/monitor').MonitorEvents> = [
      'new_video',
      'live_started',
      'live_ended',
      'scheduled_live',
      'video_updated',
    ];

    for (const event of events) {
      this.monitor.on(event, (video: VideoInfo, channel: ChannelInfo) => {
        this.broadcastSSE({
          event,
          data: {
            video,
            channel,
            timestamp: new Date().toISOString(),
          },
        });
      });
    }

    this.monitor.on('cycle_complete', (stats) => {
      this.broadcastSSE({
        event: 'cycle_complete',
        data: {
          ...stats,
          timestamp: new Date().toISOString(),
        },
      });
    });
  }

  /**
   * Envia evento para todos os clientes SSE conectados
   */
  private broadcastSSE(message: { event: string; data: any }): void {
    const payload = `event: ${message.event}\ndata: ${JSON.stringify(message.data)}\n\n`;
    
    for (const client of this.sseClients) {
      try {
        client.write(payload);
      } catch (error) {
        // Cliente desconectado
        this.sseClients.delete(client);
      }
    }
  }

  /**
   * Handler de requisições HTTP
   */
  private handleRequest = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const path = url.pathname;
    const method = req.method || 'GET';

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      const db = await this.monitor.getDatabase();
      
      // ============================================
      // ROTAS SSE (Server-Sent Events)
      // ============================================
      
      if (path === '/events' && method === 'GET') {
        return this.handleSSE(req, res);
      }

      // ============================================
      // ROTAS RSS
      // ============================================

      if (path.startsWith('/rss/')) {
        return await this.handleRSS(path, res, db);
      }

      // ============================================
      // ROTAS API
      // ============================================

      if (path === '/api/status' && method === 'GET') {
        return this.sendJson(res, await this.monitor.getStatus());
      }

      if (path === '/api/channels' && method === 'GET') {
        const status = await this.monitor.getStatus();
        return this.sendJson(res, status.channels);
      }

      if (path === '/api/channels' && method === 'POST') {
        const body = await this.readBody(req);
        const { url: channelUrl } = JSON.parse(body);
        const channel = await this.monitor.addChannel(channelUrl);
        
        if (channel) {
          return this.sendJson(res, channel, 201);
        } else {
          return this.sendJson(res, { error: 'Canal não encontrado' }, 404);
        }
      }

      if (path.startsWith('/api/channels/') && method === 'DELETE') {
        const channelId = path.split('/')[3];
        
        // Remove do cache do monitor primeiro
        await this.monitor.removeChannel(channelId);
        
        // Deleta do banco (canal + vídeos + eventos)
        const deleted = await db.deleteChannel(channelId);
        
        if (deleted) {
          console.log(`🗑️ Canal deletado: ${channelId}`);
          return this.sendJson(res, { success: true, message: 'Canal deletado com sucesso' });
        } else {
          // Mesmo se não existia no banco, sucesso (já foi removido do cache)
          return this.sendJson(res, { success: true, message: 'Canal removido' });
        }
      }

      if (path === '/api/live' && method === 'GET') {
        const lives = await this.monitor.getLiveVideos();
        return this.sendJson(res, lives);
      }

      if (path === '/api/scheduled' && method === 'GET') {
        const scheduled = await this.monitor.getScheduledLives();
        return this.sendJson(res, scheduled);
      }

      // Feed de lives (ao vivo + agendadas) para o app
      if (path === '/api/lives' && method === 'GET') {
        const channelId = url.searchParams.get('channel') || undefined;
        const lives = await db.getLivesAndScheduled(channelId);
        return this.sendJson(res, lives);
      }

      // Feed "tudo" - vídeos regulares recentes (sem shorts, vods)
      if (path === '/api/feed' && method === 'GET') {
        const hours = parseInt(url.searchParams.get('hours') || '24');
        const limit = parseInt(url.searchParams.get('limit') || '100');
        const videos = await db.getRecentRegularVideos(hours, limit);
        return this.sendJson(res, videos);
      }

      if (path === '/api/events' && method === 'GET') {
        const limit = parseInt(url.searchParams.get('limit') || '50');
        const since = url.searchParams.get('since');
        
        let events;
        if (since) {
          events = await this.monitor.getEventsSince(new Date(since));
        } else {
          events = await this.monitor.getRecentEvents(limit);
        }
        
        return this.sendJson(res, events);
      }

      if (path.startsWith('/api/channels/') && path.endsWith('/videos') && method === 'GET') {
        const channelId = path.split('/')[3];
        const videos = await db.getChannelVideos(channelId, 50);
        return this.sendJson(res, videos);
      }

      // ============================================
      // ROTAS DE BOOKMARKS
      // ============================================

      // Lista vídeos com bookmark
      if (path === '/api/bookmarked' && method === 'GET') {
        const bookmarked = await db.getBookmarkedVideos();
        return this.sendJson(res, bookmarked);
      }

      // Adiciona bookmark a um vídeo
      if (path.match(/^\/api\/videos\/[^/]+\/bookmark$/) && method === 'POST') {
        const videoId = path.split('/')[3];
        const success = await db.bookmarkVideo(videoId);
        if (success) {
          return this.sendJson(res, { success: true, videoId, bookmarked: true });
        } else {
          return this.sendJson(res, { error: 'Vídeo não encontrado' }, 404);
        }
      }

      // Remove bookmark de um vídeo
      if (path.match(/^\/api\/videos\/[^/]+\/bookmark$/) && method === 'DELETE') {
        const videoId = path.split('/')[3];
        const success = await db.unbookmarkVideo(videoId);
        if (success) {
          return this.sendJson(res, { success: true, videoId, bookmarked: false });
        } else {
          return this.sendJson(res, { error: 'Vídeo não encontrado' }, 404);
        }
      }

      // Verifica se um vídeo está com bookmark
      if (path.match(/^\/api\/videos\/[^/]+\/bookmark$/) && method === 'GET') {
        const videoId = path.split('/')[3];
        const isBookmarked = await db.isBookmarked(videoId);
        return this.sendJson(res, { videoId, bookmarked: isBookmarked });
      }

      // ============================================
      // PÁGINA INICIAL
      // ============================================

      if (path === '/' && method === 'GET') {
        return this.sendHtml(res, await this.getHomePage());
      }

      // 404
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));

    } catch (error) {
      console.error('Erro no handler:', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  };

  /**
   * Handler SSE
   */
  private handleSSE(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    // Envia evento inicial
    res.write(`event: connected\ndata: ${JSON.stringify({ timestamp: new Date().toISOString() })}\n\n`);

    this.sseClients.add(res);
    console.log(`📡 Cliente SSE conectado (total: ${this.sseClients.size})`);

    req.on('close', () => {
      this.sseClients.delete(res);
      console.log(`📡 Cliente SSE desconectado (total: ${this.sseClients.size})`);
    });
  }

  /**
   * Handler RSS
   */
  private async handleRSS(path: string, res: http.ServerResponse, db: DatabaseService): Promise<void> {
    let xml: string;

    try {
      const rssGenerator = new RSSGenerator(db);
      
      if (path === '/rss/live') {
        xml = await rssGenerator.generateLiveNowFeed();
      } else if (path === '/rss/scheduled') {
        xml = await rssGenerator.generateScheduledFeed();
      } else if (path === '/rss/all') {
        xml = await rssGenerator.generateCombinedFeed();
      } else if (path === '/rss/recent') {
        xml = await rssGenerator.generateAllRecentFeed(24);
      } else if (path.startsWith('/rss/channel/')) {
        const channelId = path.split('/')[3];
        xml = await rssGenerator.generateChannelFeed(channelId);
      } else {
        res.writeHead(404);
        res.end('Feed não encontrado');
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'application/rss+xml; charset=utf-8',
        'Cache-Control': 'max-age=60',
      });
      res.end(xml);
    } catch (error) {
      res.writeHead(404);
      res.end(`Erro: ${(error as Error).message}`);
    }
  }

  /**
   * Helpers
   */
  private sendJson(res: http.ServerResponse, data: any, statusCode = 200): void {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data, null, 2));
  }

  private sendHtml(res: http.ServerResponse, html: string): void {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  }

  private async readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => resolve(body));
      req.on('error', reject);
    });
  }

  /**
   * Página inicial HTML
   */
  private async getHomePage(): Promise<string> {
    const status = await this.monitor.getStatus();
    
    return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>YouTube Monitor</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { 
      font-family: 'Segoe UI', system-ui, sans-serif;
      background: linear-gradient(135deg, #0f0f23 0%, #1a1a3e 100%);
      color: #e0e0e0;
      min-height: 100vh;
      padding: 2rem;
    }
    .container { max-width: 1200px; margin: 0 auto; }
    h1 { 
      color: #ff4444;
      font-size: 2.5rem;
      margin-bottom: 0.5rem;
      text-shadow: 0 0 20px rgba(255, 68, 68, 0.3);
    }
    .subtitle { color: #888; margin-bottom: 2rem; }
    .stats { 
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 1rem;
      margin-bottom: 2rem;
    }
    .stat-card {
      background: rgba(255,255,255,0.05);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 12px;
      padding: 1.5rem;
      text-align: center;
    }
    .stat-value { font-size: 2rem; font-weight: bold; color: #fff; }
    .stat-label { color: #888; font-size: 0.9rem; }
    .stat-card.live .stat-value { color: #ff4444; }
    .section { margin-bottom: 2rem; }
    .section h2 { color: #fff; margin-bottom: 1rem; font-size: 1.3rem; }
    .endpoints { display: grid; gap: 0.5rem; }
    .endpoint {
      display: flex;
      align-items: center;
      gap: 1rem;
      padding: 0.75rem 1rem;
      background: rgba(255,255,255,0.05);
      border-radius: 8px;
      text-decoration: none;
      color: inherit;
      transition: background 0.2s;
    }
    .endpoint:hover { background: rgba(255,255,255,0.1); }
    .method {
      font-family: monospace;
      font-size: 0.8rem;
      padding: 0.25rem 0.5rem;
      border-radius: 4px;
      font-weight: bold;
    }
    .method.get { background: #22c55e; color: #000; }
    .method.post { background: #3b82f6; color: #fff; }
    .method.sse { background: #f59e0b; color: #000; }
    .method.rss { background: #ff4444; color: #fff; }
    .path { font-family: monospace; color: #a5f3fc; }
    .desc { color: #888; font-size: 0.9rem; }
    #events { 
      background: rgba(0,0,0,0.3);
      border-radius: 8px;
      padding: 1rem;
      max-height: 300px;
      overflow-y: auto;
      font-family: monospace;
      font-size: 0.85rem;
    }
    .event { padding: 0.5rem; border-bottom: 1px solid rgba(255,255,255,0.1); }
    .event-type { color: #f59e0b; }
    .status-badge {
      display: inline-block;
      padding: 0.25rem 0.75rem;
      border-radius: 20px;
      font-size: 0.8rem;
      font-weight: bold;
    }
    .status-running { background: #22c55e; color: #000; }
    .status-stopped { background: #ef4444; color: #fff; }
  </style>
</head>
<body>
  <div class="container">
    <h1>📺 YouTube Monitor</h1>
    <p class="subtitle">
      Status: <span class="status-badge ${status.isRunning ? 'status-running' : 'status-stopped'}">
        ${status.isRunning ? '🟢 Rodando' : '🔴 Parado'}
      </span>
    </p>

    <div class="stats">
      <div class="stat-card">
        <div class="stat-value">${status.stats.activeChannels}</div>
        <div class="stat-label">Canais Monitorados</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${status.stats.totalVideos}</div>
        <div class="stat-label">Vídeos no Banco</div>
      </div>
      <div class="stat-card live">
        <div class="stat-value">${status.stats.liveNow}</div>
        <div class="stat-label">🔴 Ao Vivo Agora</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${status.stats.scheduledLives}</div>
        <div class="stat-label">📅 Lives Programadas</div>
      </div>
    </div>

    <div class="section">
      <h2>📡 Eventos em Tempo Real (SSE)</h2>
      <div id="events">
        <div class="event">Conectando...</div>
      </div>
    </div>

    <div class="section">
      <h2>🔗 Endpoints API</h2>
      <div class="endpoints">
        <a href="/events" class="endpoint" target="_blank">
          <span class="method sse">SSE</span>
          <span class="path">/events</span>
          <span class="desc">Stream de eventos em tempo real</span>
        </a>
        <a href="/api/status" class="endpoint" target="_blank">
          <span class="method get">GET</span>
          <span class="path">/api/status</span>
          <span class="desc">Status do monitor</span>
        </a>
        <a href="/api/channels" class="endpoint" target="_blank">
          <span class="method get">GET</span>
          <span class="path">/api/channels</span>
          <span class="desc">Lista canais monitorados</span>
        </a>
        <a href="/api/feed" class="endpoint" target="_blank">
          <span class="method get">GET</span>
          <span class="path">/api/feed</span>
          <span class="desc">Feed "tudo" - vídeos regulares 24h</span>
        </a>
        <a href="/api/lives" class="endpoint" target="_blank">
          <span class="method get">GET</span>
          <span class="path">/api/lives</span>
          <span class="desc">Lives ao vivo + agendadas</span>
        </a>
        <a href="/api/live" class="endpoint" target="_blank">
          <span class="method get">GET</span>
          <span class="path">/api/live</span>
          <span class="desc">Lives ao vivo agora</span>
        </a>
        <a href="/api/scheduled" class="endpoint" target="_blank">
          <span class="method get">GET</span>
          <span class="path">/api/scheduled</span>
          <span class="desc">Lives programadas</span>
        </a>
        <a href="/api/events" class="endpoint" target="_blank">
          <span class="method get">GET</span>
          <span class="path">/api/events</span>
          <span class="desc">Eventos recentes</span>
        </a>
        <a href="/api/bookmarked" class="endpoint" target="_blank">
          <span class="method get">GET</span>
          <span class="path">/api/bookmarked</span>
          <span class="desc">Vídeos salvos (bookmarks)</span>
        </a>
      </div>
    </div>

    <div class="section">
      <h2>🔖 Bookmarks</h2>
      <div class="endpoints">
        <div class="endpoint">
          <span class="method post">POST</span>
          <span class="path">/api/videos/:id/bookmark</span>
          <span class="desc">Salvar vídeo</span>
        </div>
        <div class="endpoint">
          <span class="method get">DEL</span>
          <span class="path">/api/videos/:id/bookmark</span>
          <span class="desc">Remover dos salvos</span>
        </div>
      </div>
    </div>

    <div class="section">
      <h2>📰 Feeds RSS</h2>
      <div class="endpoints">
        <a href="/rss/all" class="endpoint" target="_blank">
          <span class="method rss">RSS</span>
          <span class="path">/rss/all</span>
          <span class="desc">Todos os vídeos de todos os canais</span>
        </a>
        <a href="/rss/live" class="endpoint" target="_blank">
          <span class="method rss">RSS</span>
          <span class="path">/rss/live</span>
          <span class="desc">Lives ao vivo agora</span>
        </a>
        <a href="/rss/scheduled" class="endpoint" target="_blank">
          <span class="method rss">RSS</span>
          <span class="path">/rss/scheduled</span>
          <span class="desc">Lives programadas</span>
        </a>
        <a href="/rss/recent" class="endpoint" target="_blank">
          <span class="method rss">RSS</span>
          <span class="path">/rss/recent</span>
          <span class="desc">Vídeos das últimas 24h</span>
        </a>
      </div>
    </div>
  </div>

  <script>
    const eventsDiv = document.getElementById('events');
    const eventSource = new EventSource('/events');
    
    eventSource.onopen = () => {
      eventsDiv.innerHTML = '<div class="event">✅ Conectado ao stream de eventos</div>';
    };
    
    eventSource.onerror = () => {
      eventsDiv.innerHTML += '<div class="event">❌ Erro na conexão SSE</div>';
    };
    
    ['new_video', 'live_started', 'live_ended', 'scheduled_live', 'video_updated', 'cycle_complete'].forEach(event => {
      eventSource.addEventListener(event, (e) => {
        const data = JSON.parse(e.data);
        const time = new Date().toLocaleTimeString();
        const html = '<div class="event"><span class="event-type">[' + event + ']</span> ' + time + ' - ' + JSON.stringify(data).slice(0, 100) + '...</div>';
        eventsDiv.innerHTML = html + eventsDiv.innerHTML;
        if (eventsDiv.children.length > 50) {
          eventsDiv.removeChild(eventsDiv.lastChild);
        }
      });
    });
  </script>
</body>
</html>`;
  }

  /**
   * Inicia o servidor
   */
  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = http.createServer(this.handleRequest);
      this.server.listen(this.config.port, this.config.host, () => {
        console.log(`\n🌐 Servidor HTTP rodando em http://${this.config.host}:${this.config.port}`);
        console.log(`   - Dashboard: http://localhost:${this.config.port}/`);
        console.log(`   - SSE Events: http://localhost:${this.config.port}/events`);
        console.log(`   - API: http://localhost:${this.config.port}/api/`);
        console.log(`   - RSS: http://localhost:${this.config.port}/rss/`);
        resolve();
      });
    });
  }

  /**
   * Para o servidor
   */
  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        // Fecha conexões SSE
        for (const client of this.sseClients) {
          client.end();
        }
        this.sseClients.clear();

        this.server.close(() => {
          console.log('🛑 Servidor HTTP parado');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }
}
