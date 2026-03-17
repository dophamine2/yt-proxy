// proxy-server.js — Node.js прокси для YouTube субтитров
// Запуск: node proxy-server.js
// Деплой: Vercel / Render / Railway (бесплатно)

const http = require('http');
const https = require('https');

const PORT = process.env.PORT || 3001;

function fetchUrl(url, options = {}) {
  return new Promise((resolve, reject) => {
    const { method = 'GET', headers = {}, body = null } = options;
    const urlObj = new URL(url);
    const reqOptions = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 11; Pixel 5) AppleWebKit/537.36',
        'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
        ...headers
      }
    };
    const req = https.request(reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, text: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function getTranscript(videoId, lang = 'ru') {
  // Шаг 1: получаем HTML и INNERTUBE_API_KEY
  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const { text: html } = await fetchUrl(videoUrl);

  const apiKeyMatch = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/);
  if (!apiKeyMatch) throw new Error('INNERTUBE_API_KEY not found');
  const apiKey = apiKeyMatch[1];

  // Также вытаскиваем title и channel из HTML
  const titleMatch   = html.match(/"title":"([^"]+)"/);
  const channelMatch = html.match(/"author":"([^"]+)"/);
  const title   = titleMatch   ? titleMatch[1]   : null;
  const channel = channelMatch ? channelMatch[1] : null;

  // Шаг 2: Innertube player API (имитируем Android)
  const playerBody = JSON.stringify({
    context: { client: { clientName: 'ANDROID', clientVersion: '20.10.38' } },
    videoId
  });
  const { text: playerJson } = await fetchUrl(
    `https://www.youtube.com/youtubei/v1/player?key=${apiKey}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: playerBody }
  );
  const playerData = JSON.parse(playerJson);

  // Шаг 3: выбираем язык (ru → en → первый доступный)
  const tracks = playerData?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!tracks || tracks.length === 0) throw new Error('No captions available');

  const track = tracks.find(t => t.languageCode === lang)
    || tracks.find(t => t.languageCode === 'en')
    || tracks[0];

  const baseUrl = track.baseUrl.replace(/&fmt=\w+$/, '');

  // Шаг 4: скачиваем XML с субтитрами
  const { text: xml } = await fetchUrl(baseUrl);

  // Парсим XML руками (без xml2js — нет зависимостей)
  const snippets = [];
  const regex = /<text start="([^"]+)" dur="([^"]+)"[^>]*>([^<]*)<\/text>/g;
  let match;
  while ((match = regex.exec(xml)) !== null) {
    const start = parseFloat(match[1]);
    const dur   = parseFloat(match[2]);
    const text  = match[3]
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"');
    snippets.push({ text, start, end: start + dur });
  }

  return { title, channel, language: track.languageCode, snippets };
}

const server = http.createServer(async (req, res) => {
  // CORS — разрешаем запросы с фронтенда
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname !== '/api/transcript') {
    res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return;
  }

  const videoId = url.searchParams.get('v');
  const lang    = url.searchParams.get('lang') || 'ru';

  if (!videoId) {
    res.writeHead(400); res.end(JSON.stringify({ error: 'Missing ?v=VIDEO_ID' })); return;
  }

  try {
    const result = await getTranscript(videoId, lang);
    res.writeHead(200);
    res.end(JSON.stringify(result));
  } catch (e) {
    res.writeHead(500);
    res.end(JSON.stringify({ error: e.message }));
  }
});

server.listen(PORT, () => console.log(`Transcript proxy running on :${PORT}`));
