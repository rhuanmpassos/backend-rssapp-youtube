/**
 * Script de teste do YouTube Scraper
 * 
 * Uso:
 *   npx ts-node examples/test-scraper.ts --test channel @MrBeast
 *   npx ts-node examples/test-scraper.ts --test videos UCX6OQ3DkcsbYNE6H8uQQuVA
 *   npx ts-node examples/test-scraper.ts --test video VIDEO_ID
 *   npx ts-node examples/test-scraper.ts --test live CHANNEL_ID
 *   npx ts-node examples/test-scraper.ts --test scheduled CHANNEL_ID
 *   npx ts-node examples/test-scraper.ts --test all @MrBeast
 */

import { YouTubeScraper, VideoInfo } from '../src/index';

const scraper = new YouTubeScraper({
  minDelay: 200,
  maxDelay: 800,
  maxConcurrent: 2,
  maxRetries: 3,
});

async function testChannel(urlOrHandle: string) {
  console.log('\n🔍 Testando extração de canal...\n');
  console.log(`Input: ${urlOrHandle}`);
  
  const info = await scraper.getChannelInfo(urlOrHandle);
  
  if (info) {
    console.log('\n✅ Canal encontrado:');
    console.log(`   Channel ID: ${info.channelId}`);
    console.log(`   Título: ${info.title}`);
    console.log(`   Descrição: ${info.description?.slice(0, 100)}...`);
    console.log(`   Thumbnail: ${info.thumbnailUrl}`);
  } else {
    console.log('❌ Canal não encontrado');
  }
  
  return info;
}

async function testVideos(channelId: string) {
  console.log('\n📺 Testando extração de vídeos via RSS...\n');
  console.log(`Channel ID: ${channelId}`);
  
  const videos = await scraper.getChannelVideos(channelId, {
    classifyVideos: true,
    maxVideosPerFeed: 5,
  });
  
  console.log(`\n✅ ${videos.length} vídeos encontrados:\n`);
  
  printVideosTable(videos);
  
  return videos;
}

async function testVideoDetails(videoId: string) {
  console.log('\n🎬 Testando detalhes de vídeo...\n');
  console.log(`Video ID: ${videoId}`);
  
  const details = await scraper.getVideoDetails(videoId);
  
  if (details) {
    console.log('\n✅ Detalhes do vídeo:');
    console.log(`   Título: ${details.title}`);
    console.log(`   Tipo: ${details.type}`);
    console.log(`   Duração: ${formatDuration(details.duration)}`);
    console.log(`   isLive: ${details.isLive}`);
    console.log(`   isLiveContent: ${details.isLiveContent}`);
    console.log(`   isUpcoming: ${details.isUpcoming}`);
    
    if (details.scheduledStartTime) {
      console.log(`   Início programado: ${details.scheduledStartTime.toISOString()}`);
    }
  } else {
    console.log('❌ Vídeo não encontrado');
  }
  
  return details;
}

async function testLiveStatus(channelId: string) {
  console.log('\n🔴 Testando status de live...\n');
  console.log(`Channel ID: ${channelId}`);
  
  const live = await scraper.checkLiveStatus(channelId);
  
  if (live) {
    console.log('\n✅ Live ativa encontrada:');
    console.log(`   Video ID: ${live.videoId}`);
    console.log(`   Título: ${live.title}`);
    console.log(`   Tipo: ${live.type}`);
  } else {
    console.log('\n⚪ Nenhuma live ativa no momento');
  }
  
  return live;
}

async function testScheduled(channelId: string) {
  console.log('\n📅 Testando lives programadas...\n');
  console.log(`Channel ID: ${channelId}`);
  
  const scheduled = await scraper.getScheduledLives(channelId);
  
  if (scheduled.length > 0) {
    console.log(`\n✅ ${scheduled.length} lives programadas:\n`);
    
    for (const live of scheduled) {
      console.log(`   📌 ${live.title}`);
      console.log(`      Video ID: ${live.videoId}`);
      console.log(`      Início: ${live.scheduledStartTime?.toISOString()}`);
      console.log('');
    }
  } else {
    console.log('\n⚪ Nenhuma live programada');
  }
  
  return scheduled;
}

async function testAll(urlOrHandle: string) {
  console.log('═'.repeat(60));
  console.log('🚀 TESTE COMPLETO DO YOUTUBE SCRAPER');
  console.log('═'.repeat(60));
  
  // 1. Extrai canal
  const channel = await testChannel(urlOrHandle);
  
  if (!channel) {
    console.log('\n❌ Não foi possível continuar sem o Channel ID');
    return;
  }
  
  // 2. Lista vídeos
  await testVideos(channel.channelId);
  
  // 3. Verifica live
  await testLiveStatus(channel.channelId);
  
  // 4. Verifica lives programadas
  await testScheduled(channel.channelId);
  
  console.log('\n' + '═'.repeat(60));
  console.log('✅ TESTE COMPLETO FINALIZADO');
  console.log('═'.repeat(60));
}

function printVideosTable(videos: VideoInfo[]) {
  const header = 'Tipo'.padEnd(10) + 'Duração'.padEnd(10) + 'Video ID'.padEnd(15) + 'Título';
  console.log(header);
  console.log('-'.repeat(70));
  
  for (const video of videos) {
    const type = video.type.padEnd(10);
    const duration = formatDuration(video.duration).padEnd(10);
    const id = video.videoId.padEnd(15);
    const title = video.title.slice(0, 30) + (video.title.length > 30 ? '...' : '');
    
    let emoji = '📺';
    if (video.type === 'short') emoji = '📱';
    if (video.type === 'live') emoji = '🔴';
    if (video.type === 'scheduled') emoji = '📅';
    if (video.type === 'vod') emoji = '🎬';
    
    console.log(`${emoji} ${type}${duration}${id}${title}`);
  }
}

function formatDuration(seconds?: number): string {
  if (!seconds) return '-';
  
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length < 2 || args[0] !== '--test') {
    console.log(`
╔═══════════════════════════════════════════════════════════════════╗
║                    YouTube Scraper - Tester                        ║
╠═══════════════════════════════════════════════════════════════════╣
║ Uso:                                                               ║
║   npx ts-node examples/test-scraper.ts --test <tipo> <input>      ║
║                                                                    ║
║ Tipos disponíveis:                                                 ║
║   channel   - Extrai info do canal (input: @handle ou URL)        ║
║   videos    - Lista vídeos do canal (input: channel_id)           ║
║   video     - Detalhes de um vídeo (input: video_id)              ║
║   live      - Verifica live ativa (input: channel_id)             ║
║   scheduled - Lista lives programadas (input: channel_id)         ║
║   all       - Executa todos os testes (input: @handle ou URL)     ║
║                                                                    ║
║ Exemplos:                                                          ║
║   npx ts-node examples/test-scraper.ts --test channel @MrBeast    ║
║   npx ts-node examples/test-scraper.ts --test all @pewdiepie      ║
╚═══════════════════════════════════════════════════════════════════╝
    `);
    return;
  }

  const testType = args[1];
  const input = args[2];

  if (!input && testType !== 'help') {
    console.log('❌ Input não fornecido. Use: --test <tipo> <input>');
    return;
  }

  console.log('\n⏳ Iniciando teste...\n');

  try {
    switch (testType) {
      case 'channel':
        await testChannel(input);
        break;
      case 'videos':
        await testVideos(input);
        break;
      case 'video':
        await testVideoDetails(input);
        break;
      case 'live':
        await testLiveStatus(input);
        break;
      case 'scheduled':
        await testScheduled(input);
        break;
      case 'all':
        await testAll(input);
        break;
      default:
        console.log(`❌ Tipo de teste desconhecido: ${testType}`);
    }
  } catch (error) {
    console.error('\n❌ Erro durante o teste:', error);
  }
}

main();

