/**
 * YouTube Monitor - Aplicação Principal
 * 
 * Monitora canais do YouTube e disponibiliza:
 * - API REST para consultas
 * - SSE para eventos em tempo real
 * - Feeds RSS personalizados
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { YouTubeMonitor } from './services/monitor';
import { MonitorServer } from './server';

// Configurações via variáveis de ambiente
const PORT = parseInt(process.env.PORT || '3001');
const HOST = process.env.HOST || '0.0.0.0';
const POLLING_INTERVAL = parseInt(process.env.POLLING_INTERVAL || '180') * 1000; // Em segundos no .env
const DATABASE_URL = process.env.DATABASE_URL || '';
const CLASSIFY_VIDEOS = process.env.CLASSIFY_VIDEOS !== 'false';
const MAX_VIDEOS_PER_FEED = parseInt(process.env.MAX_VIDEOS_PER_FEED || '15');

async function main() {
  console.log(`
╔═══════════════════════════════════════════════════════════════════╗
║                     📺 YouTube Monitor                            ║
╠═══════════════════════════════════════════════════════════════════╣
║  Monitoramento de canais com atualizações em tempo real           ║
║  API REST + SSE + Feeds RSS personalizados                        ║
╚═══════════════════════════════════════════════════════════════════╝
  `);

  if (!DATABASE_URL) {
    console.error('❌ DATABASE_URL não configurada! Configure no arquivo .env');
    process.exit(1);
  }

  console.log('📋 Configuração:');
  console.log(`   - Port: ${PORT}`);
  console.log(`   - Host: ${HOST}`);
  console.log(`   - Polling: ${POLLING_INTERVAL / 1000}s`);
  console.log(`   - Database: PostgreSQL (${DATABASE_URL.split('@')[1]?.split('/')[0] || 'configured'})`);
  console.log(`   - Classify Videos: ${CLASSIFY_VIDEOS}`);
  console.log('');

  // Cria o monitor
  const monitor = new YouTubeMonitor({
    pollingInterval: POLLING_INTERVAL,
    classifyVideos: CLASSIFY_VIDEOS,
    maxVideosPerFeed: MAX_VIDEOS_PER_FEED,
    databaseUrl: DATABASE_URL,
  });

  // Inicializa o monitor (conecta ao banco)
  console.log('🔌 Conectando ao banco de dados PostgreSQL...');
  await monitor.initialize();
  console.log('✅ Conectado ao banco de dados!');

  // Configura listeners de eventos
  monitor.on('new_video', (video, channel) => {
    console.log(`📺 Novo vídeo: "${video.title}" (${channel.title})`);
  });

  monitor.on('live_started', (video, channel) => {
    console.log(`🔴 LIVE INICIADA: "${video.title}" (${channel.title})`);
  });

  monitor.on('live_ended', (video, channel) => {
    console.log(`⚫ Live encerrada: "${video.title}" (${channel.title})`);
  });

  monitor.on('scheduled_live', (video, channel) => {
    console.log(`📅 Live programada: "${video.title}" (${channel.title}) - ${video.scheduledStartTime?.toLocaleString()}`);
  });

  monitor.on('error', (error, channelId) => {
    console.error(`❌ Erro${channelId ? ` no canal ${channelId}` : ''}:`, error.message);
  });

  monitor.on('cycle_complete', (stats) => {
    console.log(`\n✅ Ciclo completo: ${stats.channels} canais, ${stats.videos} vídeos, ${stats.events} eventos`);
  });

  // Cria e inicia o servidor
  const server = new MonitorServer(monitor, { port: PORT, host: HOST });
  await server.start();

  // Adiciona canais via argumentos de linha de comando
  const args = process.argv.slice(2);
  
  if (args.length > 0 && args[0] === '--add') {
    const channels = args.slice(1);
    console.log(`\n📌 Adicionando ${channels.length} canais...`);
    
    for (const channel of channels) {
      await monitor.addChannel(channel);
    }
  }

  // Inicia o monitoramento
  await monitor.start();

  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\n\n🛑 Encerrando...');
    monitor.stop();
    await server.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('\n\n🛑 Encerrando...');
    monitor.stop();
    await server.stop();
    process.exit(0);
  });

  // Mantém o processo rodando
  console.log('\n✨ Monitor iniciado! Pressione Ctrl+C para sair.\n');
}

main().catch(console.error);
