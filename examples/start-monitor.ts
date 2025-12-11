/**
 * Exemplo: Iniciar o monitor com canais predefinidos
 * 
 * Uso:
 *   npx ts-node examples/start-monitor.ts
 */

import { YouTubeMonitor } from '../src/services/monitor';
import { MonitorServer } from '../src/server';

// Canais para monitorar
const CHANNELS_TO_MONITOR = [
  '@RadioBandeirantesGoias',  // Tem lives programadas
  '@uStressed',               // Faz lives frequentes
];

async function main() {
  console.log('🚀 Iniciando YouTube Monitor...\n');

  // Cria o monitor com intervalo de 3 minutos
  const monitor = new YouTubeMonitor({
    pollingInterval: 3 * 60 * 1000, // 3 minutos
    classifyVideos: true,
  });

  // Configura handlers de eventos
  monitor.on('new_video', (video, channel) => {
    console.log(`\n📺 NOVO VÍDEO!`);
    console.log(`   Canal: ${channel.title}`);
    console.log(`   Título: ${video.title}`);
    console.log(`   Tipo: ${video.type}`);
    console.log(`   Link: https://youtube.com/watch?v=${video.videoId}`);
  });

  monitor.on('live_started', (video, channel) => {
    console.log(`\n🔴🔴🔴 LIVE INICIADA! 🔴🔴🔴`);
    console.log(`   Canal: ${channel.title}`);
    console.log(`   Título: ${video.title}`);
    console.log(`   Link: https://youtube.com/watch?v=${video.videoId}`);
  });

  monitor.on('live_ended', (video, channel) => {
    console.log(`\n⚫ Live encerrada`);
    console.log(`   Canal: ${channel.title}`);
    console.log(`   Título: ${video.title}`);
  });

  monitor.on('scheduled_live', (video, channel) => {
    console.log(`\n📅 LIVE PROGRAMADA!`);
    console.log(`   Canal: ${channel.title}`);
    console.log(`   Título: ${video.title}`);
    console.log(`   Início: ${video.scheduledStartTime?.toLocaleString('pt-BR')}`);
    console.log(`   Link: https://youtube.com/watch?v=${video.videoId}`);
  });

  monitor.on('cycle_complete', (stats) => {
    console.log(`\n─────────────────────────────────────────`);
    console.log(`📊 Status: ${stats.channels} canais | ${stats.videos} vídeos`);
    console.log(`   Próxima verificação em 3 minutos...`);
    console.log(`─────────────────────────────────────────`);
  });

  // Cria o servidor HTTP
  const server = new MonitorServer(monitor, { port: 3000 });
  await server.start();

  // Adiciona os canais
  console.log('\n📌 Adicionando canais para monitorar...\n');
  
  for (const channel of CHANNELS_TO_MONITOR) {
    await monitor.addChannel(channel);
  }

  // Inicia o polling
  monitor.start();

  // Mostra status inicial
  const status = monitor.getStatus();
  console.log(`\n📊 Status inicial:`);
  console.log(`   Canais: ${status.stats.activeChannels}`);
  console.log(`   Vídeos no banco: ${status.stats.totalVideos}`);
  console.log(`   Lives ao vivo: ${status.stats.liveNow}`);
  console.log(`   Lives programadas: ${status.stats.scheduledLives}`);

  console.log(`\n🌐 Acesse http://localhost:3000 para o dashboard`);
  console.log(`📡 Conecte em http://localhost:3000/events para eventos em tempo real`);
  console.log(`📰 Feeds RSS em http://localhost:3000/rss/`);
  console.log(`\nPressione Ctrl+C para encerrar.\n`);

  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\n\n🛑 Encerrando...');
    monitor.stop();
    await server.stop();
    process.exit(0);
  });
}

main().catch(console.error);

